import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenArvaAgent } from './agent.js';
import { editWorkspaceFile } from '../tools/workspace.js';

const originalDatabase = process.env.OPENARVA_AUTONOMOUS_DB;

afterEach(() => {
  if (originalDatabase === undefined) delete process.env.OPENARVA_AUTONOMOUS_DB;
  else process.env.OPENARVA_AUTONOMOUS_DB = originalDatabase;
});

describe('legacy agent tool dispatch', () => {
  it('uses the shared approval policy and denies a file edit without creating the file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openarva-legacy-tool-'));
    process.env.OPENARVA_AUTONOMOUS_DB = ':memory:';
    const agent = new OpenArvaAgent();
    const target = join(directory, 'should-not-exist.txt');

    try {
      await expect(agent.executeNativeTool('workspace.edit', {
        path: target,
        content: 'must not be written',
        cwd: directory,
      })).rejects.toThrow('Permission denied for MODERATE tool workspace.edit');
      expect(existsSync(target)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects legacy autoApprove input instead of treating it as authorization', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openarva-legacy-auto-approve-'));
    process.env.OPENARVA_AUTONOMOUS_DB = ':memory:';
    const agent = new OpenArvaAgent();
    const target = join(directory, 'should-not-exist.txt');

    try {
      await expect(agent.executeNativeTool('workspace.edit', {
        path: target,
        content: 'must not be written',
        cwd: directory,
        autoApprove: true,
      })).rejects.toThrow();
      expect(existsSync(target)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('protects direct workspace helper calls outside the agent registry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openarva-direct-edit-'));
    const target = join(directory, 'direct-call.txt');
    try {
      await expect(editWorkspaceFile(target, 'must not be written', directory)).rejects.toThrow('Permission denied for MODERATE tool workspace.edit');
      expect(existsSync(target)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});