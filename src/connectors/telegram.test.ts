import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../security/network.js', () => ({
  fetchPublicHttp: vi.fn(),
}));

import { fetchPublicHttp } from '../security/network.js';
import { TelegramConnector } from './telegram.js';

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.mocked(fetchPublicHttp).mockReset();
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

describe('Telegram connector access controls', () => {
  it('does not poll Telegram when no chat allowlist is configured', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    delete process.env.TELEGRAM_ALLOWED_CHAT_IDS;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const connector = new TelegramConnector();

    await connector.start(async () => undefined);

    expect(fetchPublicHttp).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('TELEGRAM_ALLOWED_CHAT_IDS'));
  });

  it('routes only allowlisted chat messages and disables redirects for token-bearing API requests', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.TELEGRAM_ALLOWED_CHAT_IDS = '20';
    vi.mocked(fetchPublicHttp).mockResolvedValue({
      url: 'https://api.telegram.org/',
      status: 200,
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify({
        ok: true,
        result: [
          { update_id: 1, message: { chat: { id: 10 }, text: 'unauthorized' } },
          { update_id: 2, message: { chat: { id: 20 }, text: 'authorized' } },
        ],
      })),
    });
    const connector = new TelegramConnector();
    const received: string[] = [];
    let resolveReceived!: () => void;
    const gotMessage = new Promise<void>((resolve) => { resolveReceived = resolve; });

    await connector.start(async (message) => {
      received.push(message.text);
      await connector.stop();
      resolveReceived();
    });
    await gotMessage;

    expect(received).toEqual(['authorized']);
    expect(fetchPublicHttp).toHaveBeenCalledWith(
      expect.stringContaining('api.telegram.org/bottest-token/getUpdates'),
      expect.objectContaining({ maxRedirects: 0, allowJson: true }),
    );
  });
});
