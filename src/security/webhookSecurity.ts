import Database from 'better-sqlite3';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface ReplayGuard {
  consume(key: string, expiresAt: number, now: number): boolean;
}

export class MemoryReplayGuard implements ReplayGuard {
  private readonly seen = new Map<string, number>();
  consume(key: string, expiresAt: number, now: number) {
    for (const [item, expiry] of this.seen) if (expiry <= now) this.seen.delete(item);
    if (this.seen.has(key)) return false;
    this.seen.set(key, expiresAt);
    return true;
  }
}

export class SqliteReplayGuard implements ReplayGuard {
  private readonly database: InstanceType<typeof Database>;
  constructor(databasePath = process.env.OPENARVA_REPLAY_DB || join(homedir(), '.openarva', 'webhook-replays.sqlite')) {
    if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new Database(databasePath);
    this.database.exec('CREATE TABLE IF NOT EXISTS webhook_replays (replay_key TEXT PRIMARY KEY, expires_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS idx_webhook_replays_expiry ON webhook_replays(expires_at);');
  }
  consume(key: string, expiresAt: number, now: number) {
    this.database.prepare('DELETE FROM webhook_replays WHERE expires_at <= ?').run(now);
    try {
      this.database.prepare('INSERT INTO webhook_replays (replay_key, expires_at) VALUES (?, ?)').run(key, expiresAt);
      return true;
    } catch (error) {
      if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || (error as { code?: string }).code === 'SQLITE_CONSTRAINT') return false;
      throw error;
    }
  }
  close() { this.database.close(); }
}

let defaultReplayGuard: SqliteReplayGuard | undefined;
function getDefaultReplayGuard() {
  defaultReplayGuard ||= new SqliteReplayGuard();
  return defaultReplayGuard;
}

export interface SignedWebhookInput {
  body: string;
  secret: string;
  signature?: string;
  timestamp?: string;
  nonce?: string;
  nowMs?: number;
  toleranceMs?: number;
  replayGuard?: ReplayGuard;
}

export type SignedWebhookResult = { ok: true } | { ok: false; reason: 'missing_configuration' | 'invalid_timestamp' | 'stale_timestamp' | 'invalid_nonce' | 'invalid_signature' | 'replay' };

export function signWebhookBody(body: string, secret: string, timestamp: string, nonce: string) {
  return createHmac('sha256', secret).update(`${timestamp}.${nonce}.${body}`).digest('hex');
}

export function verifySignedWebhook(input: SignedWebhookInput): SignedWebhookResult {
  const { body, secret, signature, timestamp, nonce } = input;
  if (!secret) return { ok: false, reason: 'missing_configuration' };
  if (!timestamp || !/^\d{10}$/.test(timestamp)) return { ok: false, reason: 'invalid_timestamp' };
  if (!nonce || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) return { ok: false, reason: 'invalid_nonce' };
  const now = input.nowMs ?? Date.now();
  const requestTime = Number(timestamp) * 1000;
  const toleranceMs = Math.min(15 * 60_000, Math.max(1_000, input.toleranceMs ?? 5 * 60_000));
  if (Math.abs(now - requestTime) > toleranceMs) return { ok: false, reason: 'stale_timestamp' };
  const supplied = (signature || '').replace(/^sha256=/i, '');
  if (!/^[a-f0-9]{64}$/i.test(supplied)) return { ok: false, reason: 'invalid_signature' };
  const expected = Buffer.from(signWebhookBody(body, secret, timestamp, nonce), 'hex');
  const actual = Buffer.from(supplied, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return { ok: false, reason: 'invalid_signature' };
  const guard = input.replayGuard || getDefaultReplayGuard();
  if (!guard.consume(`${secret.slice(0, 8)}:${nonce}`, requestTime + toleranceMs, now)) return { ok: false, reason: 'replay' };
  return { ok: true };
}