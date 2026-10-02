import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../security/network.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../security/network.js')>();
  return { ...actual, fetchPublicHttp: vi.fn() };
});

import { fetchPublicHttp } from '../security/network.js';
import { discordMessageToOpenArvaMessage, DiscordConnector } from './discord.js';

afterEach(() => vi.clearAllMocks());

describe('Discord connector', () => {
  it('normalizes inbound text and attachments to the strict OpenArvaMessage schema', () => {
    const message = discordMessageToOpenArvaMessage({
      id: 'message-1',
      channel_id: 'channel-1',
      guild_id: 'guild-1',
      content: 'hello',
      timestamp: new Date().toISOString(),
      author: { id: 'user-1', username: 'tester', bot: false },
      attachments: [{ url: 'https://cdn.discordapp.com/files/photo.png', content_type: 'image/png', filename: 'photo.png', size: 128 }],
    });

    expect(message).toMatchObject({
      platform: 'discord',
      conversationId: 'channel-1',
      sender: { id: 'user-1', displayName: 'tester' },
      content: { text: 'hello', parts: [{ type: 'text' }, { type: 'image', mimeType: 'image/png', fileName: 'photo.png', sizeBytes: 128 }] },
      metadata: { guildId: 'guild-1' },
    });
    expect(discordMessageToOpenArvaMessage({
      id: 'message-2',
      channel_id: 'channel-1',
      content: 'from bot',
      author: { id: 'bot-1', bot: true },
    })).toBeUndefined();
    expect(() => discordMessageToOpenArvaMessage({
      id: 'message-3',
      channel_id: 'channel-1',
      timestamp: new Date().toISOString(),
      author: { id: 'user-1' },
      attachments: [{ url: 'https://127.0.0.1/private.png', content_type: 'image/png' }],
    })).toThrow('public HTTPS');
  });

  it('sends only to allowlisted channels using authenticated, non-redirecting Discord REST', async () => {
    vi.mocked(fetchPublicHttp).mockResolvedValue({
      url: 'https://discord.com/api/v10/channels/channel-1/messages',
      status: 200,
      contentType: 'application/json',
      body: Buffer.from('{}'),
    });
    const connector = new DiscordConnector();
    const config = { token: 'test-token', allowedChannelIds: ['channel-1'] };

    await connector.send({
      platform: 'discord',
      conversationId: 'channel-1',
      text: 'hello',
      replyToMessageId: 'message-0',
    }, config);

    expect(fetchPublicHttp).toHaveBeenCalledWith(
      'https://discord.com/api/v10/channels/channel-1/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bot test-token' }),
        maxRedirects: 0,
      }),
    );
    await expect(connector.send({
      platform: 'discord',
      conversationId: 'untrusted-channel',
      text: 'hello',
    }, config)).rejects.toThrow('not in DISCORD_ALLOWED_CHANNEL_IDS');
    expect(fetchPublicHttp).toHaveBeenCalledTimes(1);
  });
});
