// webhook_server.js
// Requisitos:
// npm i express puppeteer-extra puppeteer-core puppeteer-extra-plugin-stealth node-fetch@2

const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fetch = require('node-fetch');
const fs = require('fs');

puppeteer.use(StealthPlugin());

const PORT = process.env.PORT || 3000;

// Target / origin (onde seu PHP espera receber)
const TARGET = 'https://raspagreenio.rf.gd/callbackpayment/bullspay.php';
const POST_URL = TARGET; // usa o mesmo link do seu código

// caminhos prováveis do Chromium no Termux (ajuste se necessário)
const CHROME_PATHS = [
  '/data/data/com.termux/files/usr/bin/chromium-browser',
  '/data/data/com.termux/files/usr/bin/headless_shell',
  '/data/data/com.termux/files/usr/bin/chromium',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
];

function findExecutable() {
  for (const p of CHROME_PATHS) {
    try { if (fs.existsSync(p)) return p; } catch(e){}
  }
  return null;
}

let browserInstance = null;
let busy = false; // bloqueio simples para não processar concorrência no celular (pode ajustar)

// função que garante que exista browser rodando
async function ensureBrowser() {
  if (browserInstance) return browserInstance;
  const exe = findExecutable();
  if (!exe) throw new Error('Chromium não encontrado. Ajuste CHROME_PATHS ou instale chromium no Termux.');
  browserInstance = await puppeteer.launch({
    headless: true,
    executablePath: exe,
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
  });
  return browserInstance;
}

async function obtainTestCookie(page, targetUrl) {
  // vai até a página que gera o cookie e espera o __test
  await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 45000 }).catch(()=>{});
  // polling por cookie
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

const app = express();
app.use(express.json({ limit: '1mb' })); // aceita JSON

app.post('/proxy-webhook', async (req, res) => {
  if (busy) {
    res.status(429).json({ error: 'server busy, try again shortly' });
    return;
  }
  busy = true;

  const incomingPayload = req.body;
  console.log('Recebido webhook. Payload:', JSON.stringify(incomingPayload).slice(0, 1000));

  try {
    const browser = await ensureBrowser();

    // cria nova page por requisição
    const page = await browser.newPage();

    // disfarces básicos (stealth já aplicado, mas reforça)
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
    });

    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
    await page.setUserAgent(ua);

    console.log('Abrindo página anti-bot para obter cookie __test...');
    const cookieObj = await obtainTestCookie(page, TARGET);

    if (!cookieObj) {
      // salva debug html
      const html = await page.content().catch(()=>'<no-html>');
      fs.writeFileSync('debug_page.html', html);
      await page.close();
      busy = false;
      res.status(500).json({ error: '__test cookie not found', debug_file: 'debug_page.html' });
      return;
    }

    console.log('__test cookie obtido:', cookieObj.value);

    // fecha a page (economiza recursos)
    await page.close();

    // faz o POST para o POST_URL com o cookie e payload recebido
    const forwardResp = await fetch(POST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': ua,
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://raspagreenio.rf.gd/',
        'Cookie': `__test=${cookieObj.value}`
      },
      body: JSON.stringify(incomingPayload)
    });

    const forwardText = await forwardResp.text();
    console.log('Repassado. status:', forwardResp.status);

    busy = false;
    res.status(forwardResp.status).send(forwardText);

  } catch (err) {
    console.error('Erro no processamento:', err && (err.stack || err.message || err));
    busy = false;
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
});

// rota simples para healthcheck
app.get('/', (req, res) => res.send('proxy-webhook up'));

app.listen(PORT, () => {
  console.log(`Proxy webhook rodando na porta ${PORT}`);
});
