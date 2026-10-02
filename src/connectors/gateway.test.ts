import { describe, expect, it } from 'vitest';
import { MultiChannelGateway, type GatewayConnector, type InboundMessage, type OutboundMessage } from './gateway.js';
import { MemoryReplayGuard } from '../security/webhookSecurity.js';
import { createRequire } from 'node:module';

class FakeConnector implements GatewayConnector {
  readonly channel = 'telegram' as const;
  sent: OutboundMessage[] = [];

  async start() {}
  async stop() {}
  async send(message: OutboundMessage) {
    this.sent.push(message);
  }
}

class FakeWhatsAppConnector implements GatewayConnector {
  readonly channel = 'whatsapp' as const;
  readonly sent: OutboundMessage[] = [];
  async start() {}
  async stop() {}
  async send(message: OutboundMessage) { this.sent.push(message); }
  parseWebhook(body: string): InboundMessage | null {
    const params = Object.fromEntries(new URLSearchParams(body).entries());
    if (!params.Body || !params.From) return null;
    return { channel: 'whatsapp', senderId: params.From, text: params.Body, receivedAt: new Date().toISOString() };
  }
}

const require = createRequire(import.meta.url);
const twilio = require('twilio') as { getExpectedTwilioSignature(token: string, url: string, params: Record<string, string>): string };

describe('multi-channel gateway', () => {
  it('refuses a non-loopback bind without an explicit authentication key', async () => {
    const originalAuthKey = process.env.OPENARVA_AUTH_KEY;
    delete process.env.OPENARVA_AUTH_KEY;
    const gateway = new MultiChannelGateway({ host: '0.0.0.0', port: 0, connectors: [] });
    try {
      await expect(gateway.start()).rejects.toThrow('OPENARVA_AUTH_KEY is required');
    } finally {
      if (originalAuthKey === undefined) delete process.env.OPENARVA_AUTH_KEY;
      else process.env.OPENARVA_AUTH_KEY = originalAuthKey;
    }
  });

  it('routes inbound messages through the agent and sends the response back', async () => {
    const connector = new FakeConnector();
    const gateway = new MultiChannelGateway({
      agent: { respond: async (text) => `reply:${text}` },
      connectors: [connector],
    });

    const inbound: InboundMessage = {
      channel: 'telegram',
      senderId: 'chat-1',
      text: 'hello',
      receivedAt: new Date().toISOString(),
    };

    await gateway.route(inbound);

    expect(connector.sent).toHaveLength(1);
    expect(connector.sent[0]).toMatchObject({
      channel: 'telegram',
      recipientId: 'chat-1',
      text: 'reply:hello',
      replyTo: inbound,
    });
  });

  it('rejects forged WhatsApp webhooks and deduplicates valid Twilio MessageSid deliveries', async () => {
    const originalToken = process.env.TWILIO_AUTH_TOKEN;
    const originalUrl = process.env.TWILIO_WHATSAPP_WEBHOOK_URL;
    const originalAllowedSenders = process.env.WHATSAPP_ALLOWED_SENDERS;
    const secret = 'gateway-test-auth-token';
    const connector = new FakeWhatsAppConnector();
    const gateway = new MultiChannelGateway({
      port: 0,
      host: '127.0.0.1',
      agent: { respond: async (text) => `reply:${text}` },
      connectors: [connector],
      replayGuard: new MemoryReplayGuard(),
    });
    await gateway.start();
    const callbackUrl = `http://127.0.0.1:${gateway.getBoundPort()}/webhooks/whatsapp`;
    process.env.TWILIO_AUTH_TOKEN = secret;
    process.env.TWILIO_WHATSAPP_WEBHOOK_URL = callbackUrl;
    process.env.WHATSAPP_ALLOWED_SENDERS = '+15551234567';
    const values = { Body: 'buy', From: 'whatsapp:+15551234567', MessageSid: 'SM-replay-test-unique' };
    const body = new URLSearchParams(values).toString();
    const signature = twilio.getExpectedTwilioSignature(secret, callbackUrl, values);

    try {
      const forged = await fetch(callbackUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'invalid' }, body });
      expect(forged.status).toBe(401);

      const valid = await fetch(callbackUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature }, body });
      expect(valid.status).toBe(200);
      const unauthorizedValues = { Body: 'buy', From: 'whatsapp:+15550000000', MessageSid: 'SM-replay-test-unauthorized' };
      const unauthorizedBody = new URLSearchParams(unauthorizedValues).toString();
      const unauthorizedSignature = twilio.getExpectedTwilioSignature(secret, callbackUrl, unauthorizedValues);
      const unauthorized = await fetch(callbackUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': unauthorizedSignature }, body: unauthorizedBody });
      expect(unauthorized.status).toBe(403);
      const duplicate = await fetch(callbackUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature }, body });
      expect(duplicate.status).toBe(409);
      expect(connector.sent).toHaveLength(1);
      expect(connector.sent[0]?.text).toBe('reply:buy');
    } finally {
      await gateway.stop();
      if (originalToken === undefined) delete process.env.TWILIO_AUTH_TOKEN;
      else process.env.TWILIO_AUTH_TOKEN = originalToken;
      if (originalUrl === undefined) delete process.env.TWILIO_WHATSAPP_WEBHOOK_URL;
      else process.env.TWILIO_WHATSAPP_WEBHOOK_URL = originalUrl;
      if (originalAllowedSenders === undefined) delete process.env.WHATSAPP_ALLOWED_SENDERS;
      else process.env.WHATSAPP_ALLOWED_SENDERS = originalAllowedSenders;
    }
  });
});
