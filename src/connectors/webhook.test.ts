import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { handleEnterpriseWebhook, verifyWebhookSignature } from './webhook.js';
import { MemoryReplayGuard, signWebhookBody, verifySignedWebhook } from '../security/webhookSecurity.js';
import { FixedWindowRateLimiter } from '../security/rateLimit.js';

describe('enterprise webhooks', () => {
  it('verifies signatures and sanitizes payloads before handling', async () => {
    const secret = 'test-secret';
    const body = JSON.stringify({ card: '4111111111111111' });
    const signature = createHmac('sha256', secret).update(body).digest('hex');
    expect(verifyWebhookSignature(body, signature, secret)).toBe(true);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = 'test-nonce-0123456789';
    const signed = signWebhookBody(body, secret, timestamp, nonce);
    const replayGuard = new MemoryReplayGuard();
    const request = { method: 'POST', path: '/core-banking', headers: { 'content-type': 'application/json', 'x-openarva-signature': signed, 'x-openarva-timestamp': timestamp, 'x-openarva-nonce': nonce }, body, role: 'operator' as const, actor: 'test-agent' };
    const response = await handleEnterpriseWebhook(request, { secret, replayGuard, requiredPermission: 'customer:write', handler: async (payload) => payload });
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).toContain('REDACTED_CREDIT_CARD');
    expect((await handleEnterpriseWebhook(request, { secret, replayGuard, handler: async () => ({}) })).status).toBe(409);
  });

  it('rejects stale timestamps, altered bodies, and absent signatures', () => {
    const body = '{"ok":true}';
    const secret = 'unit-test-secret';
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = 'another-nonce-012345';
    const signature = signWebhookBody(body, secret, timestamp, nonce);
    const replayGuard = new MemoryReplayGuard();

    expect(verifySignedWebhook({ body, secret, timestamp, nonce, signature, nowMs: Date.now() + 10 * 60_000, replayGuard })).toMatchObject({ ok: false, reason: 'stale_timestamp' });
    expect(verifySignedWebhook({ body: `${body} `, secret, timestamp, nonce, signature, replayGuard })).toMatchObject({ ok: false, reason: 'invalid_signature' });
    expect(verifySignedWebhook({ body, secret, timestamp, nonce, replayGuard })).toMatchObject({ ok: false, reason: 'invalid_signature' });
  });

  it('rate-limits enterprise webhook callers before repeated validation work', async () => {
    const rateLimiter = new FixedWindowRateLimiter(1, 60_000);
    const request = { method: 'POST', path: '/test', headers: {}, body: '{}', role: 'operator' as const, actor: 'client-1' };
    const options = { secret: 'test-secret', rateLimiter, handler: async () => ({ ok: true }) };

    expect((await handleEnterpriseWebhook(request, options)).status).toBe(401);
    expect((await handleEnterpriseWebhook(request, options)).status).toBe(429);
  });
});
