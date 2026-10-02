import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getOpenArvaConfigPath as getCanonicalConfigPath } from '../config/env.js';
import { isLocalOnlyMode } from '../security/privacy.js';
import { getModelProvider, getOpenArvaConfigPath, getProviderCandidates, resolveTaskModelRoute, routeAiCompletion, routeAiVisionCompletion } from './providers.js';
import { OpenArvaRouter } from './router.js';

const originalEnv = { ...process.env };

afterEach(() => {
  vi.unstubAllEnvs();
  process.env = { ...originalEnv };
});

describe('task model routing', () => {
  it('chooses a profile-specific model through the configured provider', () => {
    process.env.OPENARVA_PROVIDER = 'ollama';
    delete process.env.OPENARVA_CODING_PROVIDER;
    delete process.env.OPENARVA_CODING_MODEL;

    expect(resolveTaskModelRoute('coding')).toMatchObject({ provider: 'ollama', model: 'qwen2.5-coder' });
  });

  it('honors per-capability provider and model overrides', () => {
    process.env.OPENARVA_RESEARCH_PROVIDER = 'gemini';
    process.env.OPENARVA_RESEARCH_MODEL = 'research-preview';

    expect(resolveTaskModelRoute('research')).toMatchObject({ provider: 'gemini', model: 'research-preview' });
  });

  it('selects a multimodal provider for vision when configured credentials are available', () => {
    process.env.OPENARVA_PROVIDER = 'deepseek';
    process.env.GEMINI_API_KEY = 'configured-test-key';
    delete process.env.OPENARVA_VISION_PROVIDER;

    expect(resolveTaskModelRoute('vision')).toMatchObject({ provider: 'gemini', model: 'gemini-2.5-pro' });
  });

  it('never includes cloud providers in local-only fallback candidates', () => {
    expect(getProviderCandidates('ollama', true)).toEqual(['ollama']);
    expect(() => getProviderCandidates('openai', true)).toThrow('rejects non-local provider');
  });

  it('rejects a cloud profile override while local-only mode is active', () => {
    process.env.OPENARVA_LOCAL_ONLY = 'true';
    process.env.OPENARVA_CODING_PROVIDER = 'openai';

    expect(() => resolveTaskModelRoute('coding')).toThrow('Local-only mode rejects openai');
  });

  it('rejects direct cloud model factories in local-only mode', () => {
    process.env.OPENARVA_LOCAL_ONLY = 'true';
    process.env.LOCAL_AI_PROVIDER = 'ollama';
    process.env.LOCAL_AI_BASE_URL = 'http://127.0.0.1:11434/v1';

    expect(() => getModelProvider('openai', 'gpt-4o')).toThrow('rejects model construction');
    expect(() => OpenArvaRouter.openai('gpt-4o')).toThrow('blocks direct OpenAI model access');
    expect(() => OpenArvaRouter.local('llama3.1')).not.toThrow();
  });

  it('fails closed before image transmission if no local vision model is configured', async () => {
    process.env.OPENARVA_LOCAL_ONLY = 'true';
    process.env.LOCAL_AI_PROVIDER = 'ollama';
    delete process.env.OPENARVA_VISION_MODEL;
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (...args) => {
      fetchCalls += 1;
      return originalFetch(...args);
    }) as typeof fetch;

    try {
      await expect(routeAiVisionCompletion('describe image', new Uint8Array([1]), 'image/png')).rejects.toThrow('Cloud image transmission is blocked');
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not attempt a cloud fallback or return demo text when local completion fails', async () => {
    process.env.OPENARVA_LOCAL_ONLY = 'true';
    process.env.LOCAL_AI_PROVIDER = 'ollama';
    process.env.LOCAL_AI_BASE_URL = 'http://127.0.0.1:11434/v1';
    const requestedUrls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      requestedUrls.push(String(input));
      throw new TypeError('fetch failed');
    }) as typeof fetch;

    try {
      await expect(routeAiCompletion('private local task')).rejects.toThrow('No cloud fallback was attempted');
      expect(requestedUrls.length).toBeGreaterThan(0);
      expect(requestedUrls.every((url) => url.startsWith('http://127.0.0.1:11434/'))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('blocks remote model endpoints when local-only mode is active', async () => {
    process.env.OPENARVA_LOCAL_ONLY = 'true';
    process.env.LOCAL_AI_PROVIDER = 'ollama';
    process.env.LOCAL_AI_BASE_URL = 'https://models.example.com/v1';
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async (...args) => {
      fetchCalls += 1;
      return originalFetch(...args);
    }) as typeof fetch;

    try {
      await expect(routeAiCompletion('must remain on device')).rejects.toThrow('blocks non-loopback model endpoint');
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('loads local-only privacy mode through the canonical config path override', async () => {
    const home = await mkdtemp(join(tmpdir(), 'openarva-local-config-'));
    delete process.env.OPENARVA_LOCAL_ONLY;
    const configPath = join(home, '.openarva', 'config.json');
    vi.stubEnv('OPENARVA_CONFIG_PATH', configPath);

    try {
      await mkdir(join(home, '.openarva'), { recursive: true });
      await writeFile(configPath, JSON.stringify({ provider: 'openai', model: 'gpt-4o', privacy: { localOnly: true } }));

      expect(process.env.OPENARVA_CONFIG_PATH).toBe(configPath);
      expect(getOpenArvaConfigPath()).toBe(getCanonicalConfigPath());
      expect(getOpenArvaConfigPath()).toBe(configPath);
      expect(isLocalOnlyMode()).toBe(true);
      expect(() => resolveTaskModelRoute('coding')).not.toThrow();
      expect(resolveTaskModelRoute('coding').provider).toBe('ollama');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});