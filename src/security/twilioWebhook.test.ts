import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { verifyTwilioWebhook } from './twilioWebhook.js';

const require = createRequire(import.meta.url);
const twilio = require('twilio') as { getExpectedTwilioSignature(token: string, url: string, params: Record<string, string>): string };

describe('Twilio webhook authentication', () => {
  it('accepts a valid signature only for the fixed configured URL and exact parameters', () => {
    const token = 'test-auth-token';
    const url = 'https://public.example/webhooks/whatsapp';
    const params = { From: 'whatsapp:+15551234567', Body: 'hello', MessageSid: 'SM123' };
    const signature = twilio.getExpectedTwilioSignature(token, url, params);

    expect(verifyTwilioWebhook(token, signature, url, params)).toBe(true);
    expect(verifyTwilioWebhook(token, signature, 'https://attacker.example/webhooks/whatsapp', params)).toBe(false);
    expect(verifyTwilioWebhook(token, signature, url, { ...params, Body: 'tampered' })).toBe(false);
    expect(verifyTwilioWebhook(token, signature, undefined, params)).toBe(false);
  });
});