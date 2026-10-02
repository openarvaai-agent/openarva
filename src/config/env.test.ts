import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveOpenArvaConfig } from './env.js';

const originalPath = process.env.OPENARVA_CONFIG_PATH;
let temporaryDirectory: string | undefined;

afterEach(() => {
  if (originalPath === undefined) delete process.env.OPENARVA_CONFIG_PATH;
  else process.env.OPENARVA_CONFIG_PATH = originalPath;
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = undefined;
});

describe('OpenArva credential configuration', () => {
  it('does not persist provider or Telegram secrets in local config JSON', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'openarva-config-test-'));
    const configPath = join(temporaryDirectory, 'config.json');
    process.env.OPENARVA_CONFIG_PATH = configPath;

    saveOpenArvaConfig({
      provider: 'openai',
      model: 'gpt-test',
      apiKey: 'test-provider-secret',
      telegramBotToken: '123456:telegram-test-secret',
    });

    const saved = readFileSync(configPath, 'utf8');
    expect(saved).toContain('"provider": "openai"');
    expect(saved).not.toContain('test-provider-secret');
    expect(saved).not.toContain('telegram-test-secret');
    expect(saved).not.toContain('"apiKey"');
    expect(saved).not.toContain('"telegramBotToken"');
  });
});
