import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../security/network.js', () => ({
  fetchPublicHttp: vi.fn(),
}));

import { fetchPublicHttp } from '../security/network.js';
import { WhatsAppConnector } from './whatsapp.js';

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.TWILIO_ACCOUNT_SID = 'AC-test';
  process.env.TWILIO_AUTH_TOKEN = 'twilio-test-secret';
  process.env.TWILIO_WHATSAPP_NUMBER = 'whatsapp:+15550001111';
  vi.mocked(fetchPublicHttp).mockReset();
  vi.mocked(fetchPublicHttp).mockResolvedValue({
    url: 'https://api.twilio.com/',
    status: 200,
    contentType: 'application/json',
    body: Buffer.from('{}'),
  });
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

describe('WhatsApp outbound network boundary', () => {
  it('pins requests to Twilio and refuses redirects for credential-bearing sends', async () => {
    const connector = new WhatsAppConnector();
    await connector.send({ channel: 'whatsapp', recipientId: '+15550002222', text: 'hello' });

    expect(fetchPublicHttp).toHaveBeenCalledWith(
      'https://api.twilio.com/2010-04-01/Accounts/AC-test/Messages.json',
      expect.objectContaining({
        method: 'POST',
        allowJson: true,
        maxRedirects: 0,
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from('AC-test:twilio-test-secret').toString('base64')}`,
        }),
      }),
    );
  });
});
