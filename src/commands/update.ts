import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { providerModelDefaults, type OpenArvaProviderName } from '../config/env.js';
import { isIP } from 'node:net';
import { fetchPublicHttp } from '../security/network.js';
import { isLocalOnlyMode } from '../security/privacy.js';

const execFileAsync = promisify(execFile);
const trackedProviders: OpenArvaProviderName[] = ['gemini', 'openai', 'anthropic', 'groq', 'deepseek', 'ollama'];

export interface ModelUpdateResult {
  provider: string;
  models: string[];
  source: 'remote' | 'local' | 'fallback';
  status: 'updated' | 'available' | 'unavailable';
  detail?: string;
}

function assertLoopbackOllamaUrl(input: string) {
  const url = new URL(input);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const loopback = hostname === 'localhost' || (isIP(hostname) === 4 && hostname.startsWith('127.')) || hostname === '::1';
  if (!['http:', 'https:'].includes(url.protocol) || !loopback || url.username || url.password) {
    throw new Error('Ollama model discovery and benchmarking only allow a loopback endpoint.');
  }
  return url;
}

async function fetchJson(url: string, headers: Record<string, string> = {}, localOnly = false) {
  if (localOnly) {
    assertLoopbackOllamaUrl(url);
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(8000), redirect: 'error' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json() as Promise<Record<string, unknown>>;
  }
  const response = await fetchPublicHttp(url, {
    headers,
    signal: AbortSignal.timeout(8000),
    allowJson: true,
    maxRedirects: 0,
    maxBytes: 2_000_000,
    timeoutMs: 8000,
  });
  return JSON.parse(response.body.toString('utf8')) as Record<string, unknown>;
}

function apiHeaders(provider: string): Record<string, string> {
  const key = process.env[`${provider.toUpperCase()}_API_KEY`];
  if (!key) return {};
  return provider === 'anthropic'
    ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    : { Authorization: `Bearer ${key}` };
}

async function discoverProviderModels(provider: OpenArvaProviderName): Promise<ModelUpdateResult> {
  if (provider === 'ollama') {
    const baseUrl = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/v1\/?$/, '');
    const data = await fetchJson(`${baseUrl}/api/tags`, {}, true);
    const models = Array.isArray(data.models)
      ? data.models.flatMap((model) => typeof model === 'object' && model && 'name' in model ? [String(model.name)] : [])
      : [];
    return { provider, models, source: 'local', status: 'updated', detail: 'Local Ollama catalog discovered.' };
  }

  const baseUrls: Record<string, string> = {
    openai: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    groq: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
    deepseek: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
    gemini: process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai',
    anthropic: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  };
  const data = await fetchJson(`${baseUrls[provider]}/models`, apiHeaders(provider));
  const models = Array.isArray(data.data)
    ? data.data.flatMap((model) => typeof model === 'object' && model && 'id' in model ? [String(model.id)] : [])
    : [];
  return { provider, models, source: 'remote', status: 'updated', detail: 'Provider model catalog discovered.' };
}

export async function discoverModels(): Promise<ModelUpdateResult[]> {
  const providers = isLocalOnlyMode() ? ['ollama' as const] : trackedProviders;
  return Promise.all(providers.map(async (provider) => {
    try {
      return await discoverProviderModels(provider);
    } catch (error) {
      return {
        provider,
        models: providerModelDefaults[provider] || [],
        source: 'fallback' as const,
        status: 'unavailable' as const,
        detail: error instanceof Error ? error.message : 'Provider unavailable',
      };
    }
  }));
}

export async function pullOllamaModels(models: string[]) {
  const requested = models.length ? models : [providerModelDefaults.ollama[0]];
  const results: string[] = [];
  for (const model of requested) {
    try {
      await execFileAsync('ollama', ['pull', model], { timeout: 15 * 60 * 1000 });
      results.push(`${model}: pulled`);
    } catch (error) {
      results.push(`${model}: unavailable (${error instanceof Error ? error.message : 'pull failed'})`);
    }
  }
  return results;
}

export async function benchmarkOllama() {
  const baseUrl = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/v1\/?$/, '');
  assertLoopbackOllamaUrl(baseUrl);
  const model = process.env.OPENARVA_MODEL || providerModelDefaults.ollama[0];
  const started = Date.now();
  try {
    await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: 'ping', stream: false }),
      signal: AbortSignal.timeout(30000),
      redirect: 'error',
    });
    return `${model}: ${Date.now() - started}ms response`;
  } catch (error) {
    return `Ollama benchmark unavailable: ${error instanceof Error ? error.message : 'request failed'}`;
  }
}

export async function runModelUpdate(options: { pull?: boolean } = {}) {
  const results = await discoverModels();
  console.log('OpenArva model discovery');
  for (const result of results) {
    console.log(`${result.provider}: ${result.status} [${result.models.slice(0, 12).join(', ') || 'none'}]`);
    if (result.detail) console.log(`  ${result.detail}`);
  }

  if (options.pull) {
    const ollama = results.find((result) => result.provider === 'ollama');
    console.log('Ollama pulls:');
    for (const line of await pullOllamaModels(ollama?.models || [])) console.log(`  ${line}`);
    console.log(`Benchmark: ${await benchmarkOllama()}`);
  }

  return results;
}
