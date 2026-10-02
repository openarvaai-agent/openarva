import { describe, expect, it } from 'vitest';
import { DiscordConnector } from './discord.js';
import { webConnectorStatus } from './web.js';
import { smsIntegrationStatus } from './sms.js';
import { SipConnector } from './sip.js';
import { TelephonyPipeline } from './telephony.js';
import { OpenArvaMCPServer } from '../mcp/server.js';
import { analyzeImage } from '../tools/vision.js';

describe('incomplete integration status', () => {
  it('labels unfinished connectors and interface modules explicitly', () => {
    expect(new DiscordConnector().readiness).toBe('implemented');
    expect(webConnectorStatus).toBe('placeholder');
    expect(smsIntegrationStatus).toBe('partial');
    expect(new SipConnector({ transcribe: async () => '' }, { synthesize: async () => new Uint8Array() }).integrationStatus).toBe('interface');
    expect(new TelephonyPipeline({ transcribe: async () => '' }, { synthesize: async () => new Uint8Array() }).integrationStatus).toBe('interface');
    expect(new OpenArvaMCPServer().registeredToolCount).toBe(0);
  });

  it('does not return a fake successful image analysis for unsupported input', async () => {
    await expect(analyzeImage(Buffer.from('not an image'), 'describe')).rejects.toThrow('Unsupported image format');
  });
});