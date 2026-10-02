import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ConnectorRegistry } from './registry.js';
import { platformCatalog } from './platformCatalog.js';
import { openArvaMessageSchema, type OpenArvaMessage, type ProtocolConnector } from './protocols/index.js';
import { FixedWindowRateLimiter } from '../security/rateLimit.js';

function testConnector(onStart?: (handler: (message: OpenArvaMessage) => Promise<void>) => void): ProtocolConnector<{ token: string }> {
  return {
    id: 'test-chat',
    protocols: ['webhook'],
    readiness: 'implemented',
    requiredEnv: ['TEST_CHAT_TOKEN'],
    configSchema: z.object({ token: z.string().min(1) }).strict(),
    readConfig: (environment) => ({ token: environment.TEST_CHAT_TOKEN }),
    start: async (handler) => { onStart?.(handler); },
    stop: async () => undefined,
    send: async () => undefined,
  };
}

describe('protocol connector registry', () => {
  it('catalogs 50+ requested platforms and marks unavailable integrations honestly', () => {
    expect(platformCatalog.length).toBeGreaterThanOrEqual(50);
    expect(platformCatalog.find((item) => item.id === 'slack')?.readiness).toBe('placeholder');
    expect(platformCatalog.find((item) => item.id === 'telegram')?.readiness).toBe('implemented');
    expect(platformCatalog.find((item) => item.id === 'discord')?.readiness).toBe('implemented');
    expect(platformCatalog.find((item) => item.id === 'discord')?.requiredEnv).toEqual(['DISCORD_BOT_TOKEN', 'DISCORD_ALLOWED_CHANNEL_IDS']);
  });

  it('does not start Discord without explicit opt-in', () => {
    const registry = new ConnectorRegistry({ environment: {} as NodeJS.ProcessEnv });
    const discord = registry.list().find((item) => item.id === 'discord');
    expect(discord?.readiness).toBe('implemented');
    expect(discord?.enabled).toBe(false);
  });

  it('validates connector config and normalizes/rate-limits inbound events', async () => {
    const environment = { TEST_CHAT_TOKEN: 'local-test-token', OPENARVA_CONNECTORS: 'test-chat' } as NodeJS.ProcessEnv;
    let emit: ((message: OpenArvaMessage) => Promise<void>) | undefined;
    const registry = new ConnectorRegistry({ environment, rateLimiter: new FixedWindowRateLimiter(1, 60_000) });
    registry.register(testConnector((handler) => { emit = handler; }));
    const received = vi.fn();
    await registry.startEnabled(received);

    const message: OpenArvaMessage = {
      id: 'm-1',
      platform: 'test-chat',
      conversationId: 'room-1',
      sender: { id: 'user-1' },
      timestamp: new Date().toISOString(),
      content: { text: 'hello', parts: [] },
    };
    await emit?.(message);
    expect(received).toHaveBeenCalledWith(expect.objectContaining({ platform: 'test-chat' }));
    await expect(emit?.({ ...message, id: 'm-2' })).rejects.toThrow('rate limit');
    await expect(emit?.({ ...message, extra: true } as OpenArvaMessage)).rejects.toThrow();
    await expect(registry.send({ platform: 'test-chat', conversationId: 'room-1', text: 'hello', unexpected: true } as never)).rejects.toThrow();
    await registry.stopAll();
  });

  it('fails closed when an enabled platform has no connector implementation', async () => {
    const registry = new ConnectorRegistry({
      environment: { OPENARVA_CONNECTORS: 'slack' } as NodeJS.ProcessEnv,
    });

    await expect(registry.startEnabled(async () => undefined)).rejects.toThrow('is placeholder and has no loaded implementation');
  });

  it('validates unified media parts and rejects private attachment URLs', () => {
    const base = {
      id: 'media-1',
      platform: 'telegram',
      conversationId: 'chat-1',
      sender: { id: 'user-1' },
      timestamp: new Date().toISOString(),
      content: { parts: [{ type: 'image', url: 'https://cdn.example.org/photo.png', mimeType: 'image/png' }] },
    };
    expect(openArvaMessageSchema.parse(base).content.parts[0]?.type).toBe('image');
    expect(() => openArvaMessageSchema.parse({
      ...base,
      content: { parts: [{ type: 'audio', url: 'https://127.0.0.1/private.wav' }] },
    })).toThrow('public HTTPS');
  });

  it('requires declared credentials for explicitly enabled connector modules', async () => {
    const registry = new ConnectorRegistry({
      environment: { OPENARVA_CONNECTORS: 'test-chat' } as NodeJS.ProcessEnv,
    });
    registry.register(testConnector());

    await expect(registry.startEnabled(async () => undefined)).rejects.toThrow('TEST_CHAT_TOKEN');
  });
});
