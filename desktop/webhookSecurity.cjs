const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

function createRateLimiter(limit = 30, windowMs = 60_000, maxClients = 10_000) {
  const clients = new Map();
  return {
    allow(clientId, now = Date.now()) {
      if (!clientId || limit < 1 || windowMs < 1) return false;
      const current = clients.get(clientId);
      if (current && now - current.startedAt < windowMs) {
        if (current.count >= limit) return false;
        current.count += 1;
        return true;
      }
      if (clients.size >= maxClients) {
        for (const [key, window] of clients) if (now - window.startedAt >= windowMs) clients.delete(key);
        if (clients.size >= maxClients) return false;
      }
      clients.set(clientId, { startedAt: now, count: 1 });
      return true;
    },
  };
}

function secureEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseTimestamp(value) {
  if (/^\d{10}$/.test(String(value))) return Number(value) * 1000;
  if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value)) return Date.parse(value);
  return NaN;
}

function createTradingViewAuthenticator(secret, options = {}) {
  const databasePath = options.databasePath || process.env.OPENARVA_REPLAY_DB || path.join(os.homedir(), '.openarva', 'webhook-replays.sqlite');
  if (databasePath !== ':memory:') fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
  database.exec('CREATE TABLE IF NOT EXISTS webhook_replays (replay_key TEXT PRIMARY KEY, expires_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS idx_webhook_replays_expiry ON webhook_replays(expires_at);');

  function verify(body, rawBody, headers = {}) {
    if (!secret) return { ok: false, status: 503, reason: 'webhook authentication is not configured' };
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, status: 400, reason: 'JSON object required' };

    const timestamp = String(headers['x-openarva-timestamp'] || body.timestamp || '');
    const nonce = String(headers['x-openarva-nonce'] || body.nonce || '');
    const timestampMs = parseTimestamp(timestamp);
    const now = (options.now || Date.now)();
    if (!Number.isFinite(timestampMs) || Math.abs(now - timestampMs) > 5 * 60_000) return { ok: false, status: 401, reason: 'missing or stale timestamp' };
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) return { ok: false, status: 401, reason: 'missing or invalid nonce' };

    const signature = String(headers['x-openarva-signature'] || '').replace(/^sha256=/i, '');
    const signedPayloadValid = /^[a-f0-9]{64}$/i.test(signature)
      && secureEqual(signature.toLowerCase(), crypto.createHmac('sha256', secret).update(`${timestamp}.${nonce}.${rawBody}`).digest('hex'));
    const bodySecretValid = typeof body.secret === 'string' && secureEqual(body.secret, secret);
    if (!signedPayloadValid && !bodySecretValid) return { ok: false, status: 401, reason: 'invalid webhook authentication' };

    const replayKey = crypto.createHash('sha256').update(`${secret}:${nonce}`).digest('hex');
    database.prepare('DELETE FROM webhook_replays WHERE expires_at <= ?').run(now);
    try {
      database.prepare('INSERT INTO webhook_replays (replay_key, expires_at) VALUES (?, ?)').run(replayKey, timestampMs + 5 * 60_000);
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || error.code === 'SQLITE_CONSTRAINT') return { ok: false, status: 409, reason: 'replayed webhook request' };
      throw error;
    }

    const safeBody = { ...body };
    delete safeBody.secret;
    delete safeBody.signature;
    delete safeBody.nonce;
    delete safeBody.timestamp;
    return { ok: true, body: safeBody };
  }

  return { verify, close: () => database.close() };
}

module.exports = { createRateLimiter, createTradingViewAuthenticator };