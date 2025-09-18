// webhook_server.js
// Requisitos:
// npm i express puppeteer-extra puppeteer puppeteer-extra-plugin-stealth node-fetch@2
//
// Explicação de variáveis de ambiente (opções fáceis):
// PORT - porta (default 3000)
// POST_URL - seu endpoint final (default: same TARGET below)
// TARGET - página que gera o cookie __test (default same as POST_URL)
// CONCURRENCY - número máximo de workers (browsers) (default 2)
// COOKIE_TTL - ms para cache do __test cookie (default 120000 = 2min)
// BROWSER_IDLE_TIMEOUT - ms para fechar browser ocioso (default 60000 = 1min)
// SYNC_RESPONSE - "true" para manter o comportamento síncrono (default "true")
// ASYNC_RESPONSE - alternativa (se true, responderá 200 e processa em background)
// DEBUG_DUMP - "true" para salvar debug_page_<ts>.html quando não achar cookie

const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fetch = require('node-fetch'); // v2
const fs = require('fs');

puppeteer.use(StealthPlugin());

/* === Configuráveis === */
const PORT = parseInt(process.env.PORT || '3000', 10);
const TARGET = process.env.TARGET || 'https://raspagreenio.rf.gd/callbackpayment/bullspay.php';
const POST_URL = process.env.POST_URL || TARGET;
const CONCURRENCY = Math.max(1, parseInt(process.env.CONCURRENCY || '2', 10)); // default 2
const COOKIE_TTL = parseInt(process.env.COOKIE_TTL || String(2 * 60 * 1000), 10); // 2 min
const BROWSER_IDLE_TIMEOUT = parseInt(process.env.BROWSER_IDLE_TIMEOUT || String(60 * 1000), 10); // 1 min
const SYNC_RESPONSE = (process.env.SYNC_RESPONSE || 'false').toLowerCase() === 'true'; // default keep sync
const ASYNC_RESPONSE = (process.env.ASYNC_RESPONSE || 'true').toLowerCase() === 'true';
const DEBUG_DUMP = (process.env.DEBUG_DUMP || 'false').toLowerCase() === 'true';
const PUPPETEER_EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || null;

/* === Internals === */
const app = express();
app.use(express.json({ limit: '2mb' }));

// fila em memória — cada item: { payload, resolve, reject }
const queue = [];
let waiters = []; // promises que esperam por tarefa

// Notifica um waiter quando há item novo
function notifyTaskAvailable() {
  if (waiters.length > 0) {
    const w = waiters.shift();
    try { w.resolve(); } catch (e) { /* ignore */ }
  }
}

// espera até que haja tarefa na fila
function waitForTask() {
  if (queue.length > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    waiters.push({ resolve, reject });
    // NOTA: não colocamos timeout aqui — worker poderá ser encerrado pelo idle timer
  });
}

// cria/enfileira tarefa, retorna promessa que resolve quando processada (ou rejeita)
function enqueueTask(payload) {
  return new Promise((resolve, reject) => {
    queue.push({ payload, resolve, reject });
    notifyTaskAvailable();
  });
}

// fetch com timeout e retry simples
async function fetchWithTimeout(url, opts = {}, timeoutMs = 15000, retries = 1) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(timer);
      return res;
    } catch (err) {
      clearTimeout(timer);
      if (attempt >= retries) throw err;
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
  }
}

/* Worker class: cada worker possui seu próprio browser e loop */
class Worker {
  constructor(id) {
    this.id = id;
    this.browser = null;
    this.browserLastUsed = 0;
    this.idleTimer = null;
    this.stopped = false;
    this.cachedCookie = null;
    this.cachedCookieExpires = 0;
    this.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
    this.processing = false;
    this.start(); // inicia loop
  }

  log(...args) { console.log(`[worker-${this.id}]`, ...args); }

  async launchBrowserIfNeeded() {
    if (this.browser && this.browser.isConnected && this.browser.isConnected()) {
      this.browserLastUsed = Date.now();
      return this.browser;
    }
    // fechar se inválido
    if (this.browser) {
      try { await this.browser.close(); } catch (e) {}
      this.browser = null;
    }

    const launchOptions = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--single-process',
        '--no-zygote',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-blink-features=AutomationControlled'
      ],
      defaultViewport: { width: 1200, height: 800 }
    };
    if (PUPPETEER_EXECUTABLE_PATH) {
      launchOptions.executablePath = PUPPETEER_EXECUTABLE_PATH;
      this.log('Usando PUPPETEER_EXECUTABLE_PATH:', PUPPETEER_EXECUTABLE_PATH);
    } else {
      this.log('Nenhum PUPPETEER_EXECUTABLE_PATH — puppeteer usará Chromium em node_modules');
    }

    this.browser = await puppeteer.launch(launchOptions);
    this.browserLastUsed = Date.now();
    this.log('Chromium iniciado');
    this.scheduleIdleClose();
    return this.browser;
  }

  scheduleIdleClose() {
    if (this.idleTimer) return;
    this.idleTimer = setTimeout(async () => {
      if (this.processing) {
        this.idleTimer = null;
        return;
      }
      if (queue.length === 0 && this.browser) {
        this.log('Fechando browser por inatividade para economizar RAM.');
        try { await this.browser.close(); } catch (e) { this.log('Erro ao fechar browser:', e); }
        this.browser = null;
        this.cachedCookie = null;
        this.cachedCookieExpires = 0;
      }
      this.idleTimer = null;
    }, BROWSER_IDLE_TIMEOUT);
  }

  clearIdleClose() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  // usa uma page já aberta para obter o cookie __test (mesma lógica sua)
  async obtainTestCookieUsingPage(page, targetUrl) {
    // navega e procura __test
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 45000 }).catch(()=>{});
    let testCookie = null;
    const maxAttempts = 20;
    for (let i = 0; i < maxAttempts; i++) {
      const cookies = await page.cookies().catch(() => []);
      testCookie = cookies.find(c => c.name === '__test');
      if (testCookie) break;
      const docCookie = await page.evaluate(() => document.cookie).catch(()=> '');
      if (docCookie && docCookie.includes('__test=')) {
        const m = docCookie.match(/__test=([^;]+)/);
        if (m) { testCookie = { name: '__test', value: m[1] }; break; }
      }
      await page.waitForTimeout(500);
    }
    return testCookie;
  }

  // obtém cookie com cache por worker (CACHE TTL)
  async getTestCookie(targetUrl) {
    const now = Date.now();
    if (this.cachedCookie && this.cachedCookieExpires > now) {
      return this.cachedCookie;
    }

    // abrir page para pegar cookie
    const browser = await this.launchBrowserIfNeeded();
    const page = await browser.newPage();
    try {
      // reforça stealth
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt'] });
        Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
      });
      await page.setUserAgent(this.userAgent);

      const cookieObj = await this.obtainTestCookieUsingPage(page, targetUrl);
      if (!cookieObj) {
        // dump opcional para debug
        if (DEBUG_DUMP) {
          const html = await page.content().catch(()=>'<no-html>');
          try { fs.writeFileSync(`debug_page_${Date.now()}.html`, html); } catch(e) { this.log('Falha ao salvar debug html', e); }
        }
        throw new Error('__test cookie not found');
      }

      // cacheia
      this.cachedCookie = cookieObj;
      this.cachedCookieExpires = Date.now() + COOKIE_TTL;
      return cookieObj;
    } finally {
      try { await page.close(); } catch (e) {}
    }
  }

  async processOne(payload) {
    this.processing = true;
    this.clearIdleClose();
    try {
      // obter cookie (cache local do worker)
      let cookieObj;
      try {
        cookieObj = await this.getTestCookie(POST_URL);
      } catch (err) {
        this.log('Erro ao obter __test cookie:', err && (err.stack || err.message || err));
        throw err;
      }

      // realiza POST para o POST_URL com cookie e payload
      const resp = await fetchWithTimeout(POST_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': this.userAgent,
          'Accept': 'application/json, text/plain, */*',
          'Referer': 'https://raspagreenio.rf.gd/',
          'Cookie': `__test=${cookieObj.value}`
        },
        body: JSON.stringify(payload)
      }, 15000, 1);

      const text = await resp.text();
      this.log('Forward executado -> status', resp.status);
      return { status: resp.status, body: text };
    } finally {
      this.processing = false;
      this.browserLastUsed = Date.now();
      this.scheduleIdleClose();
    }
  }

  // loop principal do worker
  async start() {
    this.log('Worker iniciado.');
    while (!this.stopped) {
      try {
        // espera até ter tarefa
        if (queue.length === 0) await waitForTask();

        // pega tarefa
        const item = queue.shift();
        if (!item) continue;

        try {
          const result = await this.processOne(item.payload);
          item.resolve(result);
        } catch (err) {
          item.reject(err);
        }
      } catch (err) {
        this.log('Erro no loop do worker:', err && (err.stack || err.message || err));
        // pequena pausa para evitar loop tight em erro
        await new Promise(r => setTimeout(r, 500));
      }
    }
    // cleanup
    if (this.browser) {
      try { await this.browser.close(); } catch (e) {}
      this.browser = null;
    }
    this.log('Worker finalizado.');
  }

  async stop() {
    this.stopped = true;
    // acorda o loop para encerrar
    waiters.forEach(w => { try { w.resolve(); } catch(e){} });
    waiters = [];
  }
}

/* Cria o pool de workers conforme CONCURRENCY */
const workers = [];
for (let i = 0; i < CONCURRENCY; i++) {
  workers.push(new Worker(i + 1));
}

/* === Express handlers === */

// Mantive a rota e o comportamento original.
// Por padrão (SYNC_RESPONSE=true) o endpoint espera o processamento e retorna o status do POST_URL.
// Se quiser comportamento async/resposta rápida, set ASYNC_RESPONSE=true (então responde 200 imediatamente).
app.post('/proxy-webhook', async (req, res) => {
  const incomingPayload = req.body;
  console.log('Recebido webhook — payload (preview):', JSON.stringify(incomingPayload).slice(0, 1000));

  // enfileira e aguarda o resultado (ou não, se ASYNC)
  if (ASYNC_RESPONSE) {
    // modo background — não bloqueia e responde 200
    enqueueTask(incomingPayload)
      .catch(err => console.error('Erro processando task em background:', err && (err.stack || err.message || err)));
    res.status(200).json({ queued: true });
    return;
  }

  // modo síncrono (padrão) — aguarda e responde com status retornado do POST_URL
  try {
    const result = await enqueueTask(incomingPayload);
    // result: { status, body }
    res.status(result && result.status ? result.status : 200).send(result && result.body ? result.body : 'OK');
  } catch (err) {
    console.error('Erro ao processar webhook (sync):', err && (err.stack || err.message || err));
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
});

// healthcheck
app.get('/', (req, res) => res.send('proxy-webhook up'));

// graceful shutdown
async function shutdown() {
  console.log('Shutting down: stopping workers and closing browsers...');
  for (const w of workers) {
    try { await w.stop(); } catch (e) {}
  }
  // small delay to let workers close browsers
  setTimeout(() => process.exit(0), 1000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

app.listen(PORT, () => {
  console.log(`Proxy webhook rodando na porta ${PORT}. CONCURRENCY=${CONCURRENCY} SYNC_RESPONSE=${SYNC_RESPONSE} ASYNC_RESPONSE=${ASYNC_RESPONSE}`);
});