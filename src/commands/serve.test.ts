import { afterEach, describe, expect, it } from 'vitest';
import { serveCommand } from './serve.js';

const originalHost = process.env.OPENARVA_HOST;
const originalAuthKey = process.env.OPENARVA_AUTH_KEY;

afterEach(() => {
  if (originalHost === undefined) delete process.env.OPENARVA_HOST;
  else process.env.OPENARVA_HOST = originalHost;
  if (originalAuthKey === undefined) delete process.env.OPENARVA_AUTH_KEY;
  else process.env.OPENARVA_AUTH_KEY = originalAuthKey;
});

describe('serve network binding', () => {
  it('requires an auth key before binding to a non-loopback interface', async () => {
    process.env.OPENARVA_HOST = '0.0.0.0';
    delete process.env.OPENARVA_AUTH_KEY;

    await expect(serveCommand(32123)).rejects.toThrow('OPENARVA_AUTH_KEY is required');
  });
});