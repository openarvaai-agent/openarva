import { createRequire } from 'node:module';
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { createRateLimiter, createTradingViewAuthenticator } = require('../../desktop/webhookSecurity.cjs') as {
  createRateLimiter(limit: number, windowMs: number, maxClients?: number): { allow(clientId: string, now?: number): boolean };
  createTradingViewAuthenticator(secret: string, options: { databasePath: string; now: () => number }): {
    verify(body: Record<string, unknown>, rawBody: string, headers?: Record<string, string>): { ok: boolean; status?: number; reason?: string; body?: Record<string, unknown> };
    close(): void;
  };
};

describe('TradingView webhook authentication', () => {
  it('rate-limits the direct client address with bounded client storage', () => {
    const limiter = createRateLimiter(2, 1000, 1);
    expect(limiter.allow('127.0.0.1', 100)).toBe(true);
    expect(limiter.allow('127.0.0.1', 200)).toBe(true);
    expect(limiter.allow('127.0.0.1', 300)).toBe(false);
    expect(limiter.allow('attacker', 300)).toBe(false);
    expect(limiter.allow('127.0.0.1', 1200)).toBe(true);
  });

  it('accepts a valid shared body secret once and removes credentials before forwarding', () => {
    const now = Date.now();
    const authenticator = createTradingViewAuthenticator('private-test-secret', { databasePath: ':memory:', now: () => now });
    const body = { secret: 'private-test-secret', timestamp: String(Math.floor(now / 1000)), nonce: 'nonce-123456789012345', ticker: 'TEST' };

    try {
      const accepted = authenticator.verify(body, JSON.stringify(body));
      expect(accepted.ok).toBe(true);
      expect(accepted.body).toEqual({ ticker: 'TEST' });
      expect(authenticator.verify(body, JSON.stringify(body))).toMatchObject({ ok: false, status: 409 });
    } finally {
      authenticator.close();
    }
  });

  it('accepts valid HMAC headers and rejects stale/forged requests', () => {
    const now = Date.now();
    const timestamp = String(Math.floor(now / 1000));
    const nonce = 'nonce-123456789012345';
    const secret = 'hmac-test-secret';
    const body = { alert: 'value' };
    const rawBody = JSON.stringify(body);
    const signature = createHmac('sha256', secret).update(`${timestamp}.${nonce}.${rawBody}`).digest('hex');
    const authenticator = createTradingViewAuthenticator(secret, { databasePath: ':memory:', now: () => now });

    try {
      expect(authenticator.verify(body, rawBody, { 'x-openarva-timestamp': timestamp, 'x-openarva-nonce': nonce, 'x-openarva-signature': `sha256=${signature}` }).ok).toBe(true);
      expect(authenticator.verify(body, rawBody, { 'x-openarva-timestamp': timestamp, 'x-openarva-nonce': 'nonce-123456789012346', 'x-openarva-signature': '0'.repeat(64) })).toMatchObject({ ok: false, status: 401 });
    } finally {
      authenticator.close();
    }
  });

  it('fails closed when the webhook secret is not configured', () => {
    const authenticator = createTradingViewAuthenticator('', { databasePath: ':memory:', now: Date.now });
    try {
      expect(authenticator.verify({}, '{}')).toMatchObject({ ok: false, status: 503 });
    } finally {
      authenticator.close();
    }
  });
});