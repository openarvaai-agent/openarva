import { afterEach, describe, expect, it } from 'vitest';
import { discoverModels } from './update.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('model discovery privacy boundaries', () => {
  it('discovers only the local Ollama catalog in local-only mode', async () => {
    process.env.OPENARVA_LOCAL_ONLY = 'true';
    process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:11434/v1';
    const urls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      urls.push(String(input));
      throw new Error('offline');
    }) as typeof fetch;

    try {
      const results = await discoverModels();
      expect(results.map((result) => result.provider)).toEqual(['ollama']);
      expect(urls).toEqual(['http://127.0.0.1:11434/api/tags']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not contact a remote Ollama endpoint in local-only mode', async () => {
    process.env.OPENARVA_LOCAL_ONLY = 'true';
    process.env.OLLAMA_BASE_URL = 'https://models.example.com/v1';
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error('must not contact remote host');
    }) as typeof fetch;

    try {
      const results = await discoverModels();
      expect(results).toHaveLength(1);
      expect(results[0]?.provider).toBe('ollama');
      expect(results[0]?.status).toBe('unavailable');
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
