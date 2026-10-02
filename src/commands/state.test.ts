import { afterEach, describe, expect, it } from 'vitest';
import { confirmAutonomousExecutionApproval, confirmExecutionApproval } from './state.js';

const originalArgv = [...process.argv];

afterEach(() => {
  process.argv = [...originalArgv];
});

describe('human approval policy', () => {
  it('does not let --yes or --force approve legacy actions in non-interactive processes', async () => {
    process.argv = [...originalArgv, '--yes', '--force'];
    expect(await confirmExecutionApproval('write a file')).toBe(false);
  });

  it('does not let global CLI flags bypass autonomous approvals', async () => {
    process.argv = [...originalArgv, '--yes', '--force'];
    expect(await confirmAutonomousExecutionApproval('send a message')).toBe(false);
  });
});