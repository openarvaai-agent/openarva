let electronApp;
try {
  electronApp = require('electron');
} catch {
  electronApp = null;
}

const { app, BrowserWindow, Menu, Tray, shell } = electronApp || {};
const { spawn } = require('node:child_process');
const path = require('node:path');
const express = require('express');
const dotenv = require('dotenv');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { createRateLimiter, createTradingViewAuthenticator } = require('./webhookSecurity.cjs');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const webhookApp = express();
let tray;
let gateway;
const port = Number(process.env.OPENARVA_PORT || 18789);
const tradingViewPort = Number(process.env.TRADINGVIEW_WEBHOOK_PORT || 3000);
const tradingViewAuthenticator = createTradingViewAuthenticator(process.env.TRADINGVIEW_WEBHOOK_SECRET || '');
const tradingViewRateLimiter = createRateLimiter(30, 60_000, 10_000);
let tradingViewEmailClient;
let tradingViewEmailTimer;

function formatValue(value, indent = 0) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => `${' '.repeat(indent)}- ${formatValue(item, indent + 2)}`).join('\n');
  }
  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([key, item]) => `${' '.repeat(indent)}${key}: ${typeof item === 'object' ? '\n' + formatValue(item, indent + 2) : formatValue(item, indent + 2)}`)
      .join('\n');
  }
  return String(value);
}

function formatTradingViewAlert(payload) {
  const summary = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  if (typeof payload === 'object' && payload !== null) {
    return `📣 TradingView Alert\n${formatValue(payload)}`;
  }
  return `📣 TradingView Alert\n${summary}`;
}

async function sendTelegramMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.error('[TradingView Webhook] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in environment/.env');
    return { ok: false, error: 'Missing Telegram configuration' };
  }

  try {
    const { fetchPublicHttp } = await import('../dist/security/network.js');
    const response = await fetchPublicHttp(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
      allowJson: true,
      maxBytes: 1_000_000,
      maxRedirects: 0,
    });

    const data = JSON.parse(response.body.toString('utf8'));
    console.log(`[Telegram] API response for chat ${chatId}:`, { status: response.status, data });
    if (!data.ok) {
      console.error('[Telegram] API error:', data);
      return { ok: false, error: data.description || 'Telegram send failed' };
    }

    return { ok: true, result: data.result };
  } catch (error) {
    console.error('[Telegram] Request error:', error instanceof Error ? error.message : String(error));
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function getTradingViewEmailConfig() {
  const host = process.env.TRADINGVIEW_IMAP_HOST || process.env.EMAIL_IMAP_HOST;
  const user = process.env.TRADINGVIEW_IMAP_USER || process.env.EMAIL_IMAP_USER;
  const password = process.env.TRADINGVIEW_IMAP_PASSWORD || process.env.EMAIL_IMAP_PASSWORD;
  if (!host || !user || !password) return null;

  return {
    host,
    port: Number(process.env.TRADINGVIEW_IMAP_PORT || process.env.EMAIL_IMAP_PORT || 993),
    secure: process.env.TRADINGVIEW_IMAP_SECURE !== 'false' && process.env.EMAIL_IMAP_SECURE !== 'false',
    auth: { user, pass: password },
    mailbox: process.env.TRADINGVIEW_IMAP_MAILBOX || process.env.EMAIL_IMAP_MAILBOX || 'INBOX',
    pollMs: Math.max(10_000, Number(process.env.TRADINGVIEW_EMAIL_POLL_MS || 30_000)),
    from: (process.env.TRADINGVIEW_EMAIL_FROM || 'tradingview.com').toLowerCase(),
    subject: (process.env.TRADINGVIEW_EMAIL_SUBJECT || '').toLowerCase(),
  };
}

function extractTradingViewEmailText(parsedMessage) {
  const text = String(parsedMessage.text || '').trim();
  if (text) return text;
  return String(parsedMessage.html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function processTradingViewEmails(client, config) {
  const lock = await client.getMailboxLock(config.mailbox);
  try {
    const messageIds = await client.search({ seen: false });
    for (const uid of messageIds) {
      const message = await client.fetchOne(uid, { envelope: true, source: true }, { uid: true });
      if (!message?.source) continue;

      const parsed = await simpleParser(message.source);
      const sender = String(parsed.from?.value?.map((entry) => entry.address).filter(Boolean).join(', ') || parsed.from?.text || '').toLowerCase();
      const subject = String(parsed.subject || '');
      console.log(`[TradingView Email] Unseen email: subject="${subject || 'no subject'}", sender="${sender || 'unknown'}"`);

      if (!sender.includes(config.from)) continue;
      console.log(`[TradingView Email] Sender matched TRADINGVIEW_EMAIL_FROM="${config.from}": ${sender}`);
      if (config.subject && !subject.toLowerCase().includes(config.subject)) continue;

      const alertText = extractTradingViewEmailText(parsed);
      if (!alertText) continue;

      console.log(`[TradingView Email] Forwarding alert from ${sender} (${parsed.subject || 'no subject'})`);
      const result = await sendTelegramMessage(`📧 TradingView Email Alert\n${alertText}`);
      if (result.ok) await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
    }
  } finally {
    lock.release();
  }
}

function startTradingViewEmailListener() {
  const config = getTradingViewEmailConfig();
  if (!config) {
    console.log('[TradingView Email] Disabled: configure TRADINGVIEW_IMAP_HOST, TRADINGVIEW_IMAP_USER, and TRADINGVIEW_IMAP_PASSWORD.');
    return;
  }

  const createClient = () => {
    const client = new ImapFlow({ host: config.host, port: config.port, secure: config.secure, auth: config.auth, logger: false });
    client.on('error', (error) => {
      console.error('[TradingView Email] Connection error:', error instanceof Error ? error.message : String(error));
      if (tradingViewEmailClient === client) tradingViewEmailClient = null;
    });
    return client;
  };

  const poll = async () => {
    try {
      if (!tradingViewEmailClient) tradingViewEmailClient = createClient();
      if (!tradingViewEmailClient.usable) {
        await tradingViewEmailClient.connect();
      }
      await processTradingViewEmails(tradingViewEmailClient, config);
    } catch (error) {
      console.error('[TradingView Email] Polling error:', error instanceof Error ? error.message : String(error));
      const failedClient = tradingViewEmailClient;
      tradingViewEmailClient = null;
      try { await failedClient?.logout(); } catch { /* reconnect on next poll */ }
    }
    tradingViewEmailTimer = setTimeout(poll, config.pollMs);
  };

  console.log(`[TradingView Email] Listening on ${config.host}:${config.port}/${config.mailbox}`);
  void poll();
}

function startTradingViewWebhookServer() {
  webhookApp.use(express.json({
    limit: '1mb',
    verify: (req, res, buffer) => { req.rawBody = buffer.toString('utf8'); },
  }));
  webhookApp.use((req, res, next) => {
    console.log(`[TradingView Webhook] ${req.method} ${req.originalUrl}`);
    next();
  });

  webhookApp.get('/health', (req, res) => {
    res.json({ ok: true, service: 'tradingview-webhook' });
  });

  webhookApp.post('/webhook/tradingview', async (req, res) => {
    if (!tradingViewRateLimiter.allow(req.socket.remoteAddress || '')) {
      res.status(429).json({ ok: false, error: 'Rate limit exceeded.' });
      return;
    }
    try {
      const authentication = tradingViewAuthenticator.verify(req.body || {}, req.rawBody || '', req.headers);
      if (!authentication.ok) {
        res.status(authentication.status).json({ ok: false, error: authentication.reason });
        return;
      }
      const payload = authentication.body;
      console.log('[TradingView Webhook] Incoming alert payload:');
      console.log(JSON.stringify(payload, null, 2));

      const formatted = formatTradingViewAlert(payload);
      const telegramResult = await sendTelegramMessage(formatted);

      res.status(200).json({
        ok: telegramResult.ok,
        received: true,
        telegram: telegramResult,
      });
    } catch (error) {
      console.error('[TradingView Webhook] Error processing webhook:', error);
      res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  webhookApp.listen(tradingViewPort, () => {
    console.log(`[TradingView Webhook] listening on http://127.0.0.1:${tradingViewPort}`);
  });

  startTradingViewEmailListener();

  return webhookApp;
}

function createWindow() {
  const window = new BrowserWindow({ width: 1100, height: 760, show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  window.loadURL(`http://127.0.0.1:${port}/dashboard`);
  window.on('close', (event) => {
    if (!app.isQuitting) { event.preventDefault(); window.hide(); }
  });
  return window;
}

if (app && typeof app.whenReady === 'function') {
  app.whenReady().then(() => {
    startTradingViewWebhookServer();
    gateway = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'index.js'), 'gateway', 'daemon', '--port', String(port)], { detached: true, stdio: 'ignore', windowsHide: true });
    gateway.unref();
    const window = createWindow();
    tray = new Tray(path.join(__dirname, '..', 'assets', 'openarva-logo.svg'));
    tray.setToolTip('OpenArva');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open OpenArva', click: () => { window.show(); } },
      { label: 'Open Dashboard', click: () => { void shell.openExternal(`http://127.0.0.1:${port}/dashboard`); } },
      { type: 'separator' },
      { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
    ]));
    tray.on('click', () => window.show());
  });

  app.on('window-all-closed', (event) => event.preventDefault());
  app.on('before-quit', () => { if (gateway?.pid) gateway.kill(); });
} else {
  startTradingViewWebhookServer();
  console.log('[Node fallback] Electron runtime unavailable; TradingView webhook server is running in Node mode.');
}