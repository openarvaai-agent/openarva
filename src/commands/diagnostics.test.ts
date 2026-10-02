import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctor } from './diagnostics.js';

const originalEnv = { ...process.env };
let tempDir: string | undefined;

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

async function configureLocalOnly(endpoint: string) {
  tempDir = await mkdtemp(join(tmpdir(), 'openarva-doctor-'));
  const configPath = join(tempDir, 'config.json');
  await writeFile(configPath, JSON.stringify({ provider: 'openai', apiKey: 'cloud-test-key' }));
  process.env.OPENARVA_CONFIG_PATH = configPath;
  process.env.OPENARVA_LOCAL_ONLY = 'true';
  process.env.OPENARVA_PROVIDER = 'openai';
  process.env.OPENAI_API_KEY = 'cloud-test-key';
  process.env.LOCAL_AI_PROVIDER = 'ollama';
  process.env.LOCAL_AI_BASE_URL = endpoint;
}

describe('doctor local-only provider checks', () => {
  it('skips cloud probes and checks only the loopback Ollama endpoint', async () => {
    await configureLocalOnly('http://localhost:11434/v1');
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runDoctor();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('http://localhost:11434/api/tags');
    expect(output.mock.calls.flat().join('\n')).toContain('skipped because local-only privacy mode is active');
    expect(output.mock.calls.flat().join('\n')).not.toContain('OPENAI connectivity');
  });

  it('blocks a non-loopback local model endpoint without making a request', async () => {
    await configureLocalOnly('https://models.example.com/v1');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runDoctor();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
