import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  AutonomousTaskRuntime,
  AutonomousToolRegistry,
  SqliteAutonomousTaskStore,
  autonomousToolSchemas,
  type AutonomousTaskRecord,
  type AutonomousTaskStore,
  type AutonomousTool,
} from './autonomous.js';
import type { ToolOperation } from '../tools/executionPolicy.js';

class MemoryTaskStore implements AutonomousTaskStore {
  readonly records = new Map<string, AutonomousTaskRecord>();
  readonly operations = new Map<string, ToolOperation>();
  create(task: AutonomousTaskRecord) { this.records.set(task.taskId, structuredClone(task)); }
  get(taskId: string) { const value = this.records.get(taskId); return value ? structuredClone(value) : null; }
  save(task: AutonomousTaskRecord) { this.records.set(task.taskId, structuredClone(task)); }
  listRecoverable() { return [...this.records.values()].filter((task) => !['completed', 'failed'].includes(task.executionState)).map((task) => structuredClone(task)); }
  getOperation(operationId: string) { const value = this.operations.get(operationId); return value ? structuredClone(value) : null; }
  begin(operationId: string, _tool: string, allowFailedRetry = false) {
    const existing = this.operations.get(operationId);
    if (!existing) {
      this.operations.set(operationId, { operationId, state: 'started' });
      return true;
    }
    if (allowFailedRetry && existing.state === 'failed') {
      this.operations.set(operationId, { operationId, state: 'started' });
      return true;
    }
    return false;
  }
  finish(operationId: string, state: Exclude<ToolOperation['state'], 'started'>, result?: unknown, error?: string) { this.operations.set(operationId, { operationId, state, result, error }); }
}

function tool(name: string, execute: AutonomousTool['execute'], options: Partial<AutonomousTool> = {}): AutonomousTool {
  return {
    name,
    description: `${name} test tool`,
    permission: 'SAFE',
    inputSchema: z.object({ value: z.string() }),
    idempotent: true,
    execute,
    ...options,
  };
}

function plan(toolName: string, value = 'ok') {
  return [{ id: 'step-1', tool: toolName, objective: `run ${toolName}`, input: { value } }];
}

function runtime(options: {
  store?: AutonomousTaskStore;
  tools?: AutonomousToolRegistry;
  planner?: (context: Parameters<NonNullable<ConstructorParameters<typeof AutonomousTaskRuntime>[0]['planner']>>[0]) => Promise<ReturnType<typeof plan>>;
  verifier?: ConstructorParameters<typeof AutonomousTaskRuntime>[0]['verifier'];
  approve?: ConstructorParameters<typeof AutonomousTaskRuntime>[0]['approve'];
  retrieveMemory?: () => string[];
  recordMemory?: ConstructorParameters<typeof AutonomousTaskRuntime>[0]['recordMemory'];
  maxRetries?: number;
  maxReplans?: number;
  defaultTimeoutMs?: number;
  logger?: (event: Record<string, unknown>) => void;
}) {
  const store = options.store || new MemoryTaskStore();
  const tools = options.tools || new AutonomousToolRegistry();
  return {
    store,
    instance: new AutonomousTaskRuntime({
      store,
      tools,
      planner: options.planner || (async () => plan(tools.list()[0]?.name || 'tool')),
      verifier: options.verifier || (async () => ({ verified: true, reason: 'expected output present' })),
      approve: options.approve,
      retrieveMemory: options.retrieveMemory,
      recordMemory: options.recordMemory,
      maxRetries: options.maxRetries,
      maxReplans: options.maxReplans,
      defaultTimeoutMs: options.defaultTimeoutMs,
      logger: options.logger || (() => undefined),
    }),
  };
}

describe('autonomous task runtime', () => {
  it('completes a simple task', async () => {
    const registry = new AutonomousToolRegistry();
    registry.register(tool('echo', async ({ value }) => value));
    const { instance } = runtime({ tools: registry });

    const task = await instance.run('echo a value');

    expect(task.executionState).toBe('completed');
    expect(task.results[0]?.output).toBe('ok');
  });

  it('executes a multi-step plan in order', async () => {
    const registry = new AutonomousToolRegistry();
    const order: string[] = [];
    registry.register(tool('first', async () => { order.push('first'); return 'one'; }));
    registry.register(tool('second', async () => { order.push('second'); return 'two'; }));
    const { instance } = runtime({ tools: registry, planner: async () => [
      { id: '1', tool: 'first', objective: 'first', input: { value: 'x' } },
      { id: '2', tool: 'second', objective: 'second', input: { value: 'x' } },
    ] });

    const task = await instance.run('two steps');

    expect(task.executionState).toBe('completed');
    expect(order).toEqual(['first', 'second']);
  });

  it('records a tool failure when replanning is disabled', async () => {
    const registry = new AutonomousToolRegistry();
    registry.register(tool('fails', async () => { throw new Error('tool exploded'); }));
    const { instance } = runtime({ tools: registry, maxReplans: 0 });

    const task = await instance.run('fail safely');

    expect(task.executionState).toBe('failed');
    expect(task.errors.join(' ')).toContain('tool exploded');
  });

  it('fails when verification does not pass and replanning is disabled', async () => {
    const registry = new AutonomousToolRegistry();
    registry.register(tool('run', async () => 'done'));
    const { instance } = runtime({ tools: registry, maxReplans: 0, verifier: async () => ({ verified: false, reason: 'output missing' }) });

    const task = await instance.run('verify output');

    expect(task.executionState).toBe('failed');
    expect(task.verification).toBe('output missing');
  });

  it('retries an idempotent tool failure up to success', async () => {
    const registry = new AutonomousToolRegistry();
    let calls = 0;
    registry.register(tool('flaky', async () => { calls += 1; if (calls === 1) throw new Error('transient'); return 'recovered'; }));
    const { instance } = runtime({ tools: registry, maxRetries: 2 });

    const task = await instance.run('retry once');

    expect(task.executionState).toBe('completed');
    expect(task.retryCount).toBe(1);
    expect(calls).toBe(2);
  });

  it('replans after a recoverable tool failure', async () => {
    const registry = new AutonomousToolRegistry();
    let calls = 0;
    registry.register(tool('unstable', async () => { calls += 1; throw new Error('unavailable'); }, { idempotent: false }));
    registry.register(tool('fallback', async () => 'fallback result'));
    const { instance } = runtime({
      tools: registry,
      maxReplans: 1,
      planner: async ({ revision }) => plan(revision === 0 ? 'unstable' : 'fallback'),
    });

    const task = await instance.run('recover using fallback');

    expect(task.executionState).toBe('completed');
    expect(task.planRevision).toBe(2);
    expect(task.results.at(-1)?.tool).toBe('fallback');
  });

  it('passes retrieved memory into planning context', async () => {
    const registry = new AutonomousToolRegistry();
    registry.register(tool('use-memory', async () => 'used'));
    let memory: string[] = [];
    const { instance } = runtime({
      tools: registry,
      retrieveMemory: () => ['remembered preference'],
      planner: async (context) => { memory = context.memory; return plan('use-memory'); },
    });

    await instance.run('use prior context');

    expect(memory).toEqual(['remembered preference']);
  });

  it('records completed and failed task outcomes for long-term memory indexing', async () => {
    const outcomes: Array<{ taskId: string; outcome: 'completed' | 'failed' }> = [];
    const successfulTools = new AutonomousToolRegistry();
    successfulTools.register(tool('remember-success', async () => 'done'));
    const success = runtime({
      tools: successfulTools,
      recordMemory: async (task, outcome) => { outcomes.push({ taskId: task.taskId, outcome }); },
    });
    const completedTask = await success.instance.run('remember completed history');

    const failedTools = new AutonomousToolRegistry();
    failedTools.register(tool('remember-error', async () => { throw new Error('remember failure'); }));
    const failure = runtime({
      tools: failedTools,
      maxReplans: 0,
      recordMemory: async (task, outcome) => { outcomes.push({ taskId: task.taskId, outcome }); },
    });
    const failedTask = await failure.instance.run('remember failed history');

    expect(completedTask.executionState).toBe('completed');
    expect(failedTask.executionState).toBe('failed');
    expect(outcomes).toEqual([
      { taskId: completedTask.taskId, outcome: 'completed' },
      { taskId: failedTask.taskId, outcome: 'failed' },
    ]);
  });

  it('denies a moderate-risk tool when approval is refused', async () => {
    const registry = new AutonomousToolRegistry();
    registry.register(tool('send-message', async () => 'sent', { permission: 'MODERATE' }));
    const { instance } = runtime({ tools: registry, approve: async () => false, maxReplans: 0 });

    const task = await instance.run('send a message');

    expect(task.executionState).toBe('failed');
    expect(task.errors.join(' ')).toContain('Permission denied');
  });

  it('atomically prevents concurrent duplicate execution for one operation ID', async () => {
    const registry = new AutonomousToolRegistry();
    let calls = 0;
    registry.register(tool('external.send', async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return 'sent';
    }, { permission: 'MODERATE', idempotent: false }));
    const { instance } = runtime({ tools: registry, approve: async () => true });
    const context = { taskId: 'duplicate-operation-task', operationId: 'stable-operation-id' };

    const outcomes = await Promise.allSettled([
      instance.executeTool('external.send', { value: 'notify' }, context),
      instance.executeTool('external.send', { value: 'notify' }, context),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    expect(calls).toBe(1);
  });

  it('uses SQLite to arbitrate concurrent operation claims across runtime instances', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openarva-operation-claim-'));
    const databasePath = join(directory, 'tasks.sqlite');
    const firstStore = new SqliteAutonomousTaskStore(databasePath);
    const secondStore = new SqliteAutonomousTaskStore(databasePath);
    const registry = new AutonomousToolRegistry();
    let calls = 0;
    registry.register(tool('external.send', async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return 'sent';
    }, { permission: 'MODERATE', idempotent: false }));
    const runtimeOptions = {
      tools: registry,
      planner: async () => plan('external.send'),
      verifier: async () => ({ verified: true, reason: 'completed' }),
      approve: async () => true,
      logger: () => undefined,
    };
    const firstRuntime = new AutonomousTaskRuntime({ ...runtimeOptions, store: firstStore });
    const secondRuntime = new AutonomousTaskRuntime({ ...runtimeOptions, store: secondStore });

    try {
      const context = { taskId: 'sqlite-duplicate-task', operationId: 'sqlite-stable-operation-id' };
      const outcomes = await Promise.allSettled([
        firstRuntime.executeTool('external.send', { value: 'notify' }, context),
        secondRuntime.executeTool('external.send', { value: 'notify' }, context),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
      expect(calls).toBe(1);
    } finally {
      firstStore.close?.();
      secondStore.close?.();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('persists task state and audit events', async () => {
    const registry = new AutonomousToolRegistry();
    registry.register(tool('persist', async () => 'stored'));
    const store = new MemoryTaskStore();
    const { instance } = runtime({ store, tools: registry, logger: () => undefined });

    const task = await instance.run('persist state');
    const stored = store.get(task.taskId);

    expect(stored?.executionState).toBe('completed');
    expect(stored?.auditEvents.map((event) => event.event)).toContain('tool_started');
    expect(stored?.auditEvents.map((event) => event.event)).toContain('task_completed');
  });

  it('resumes an interrupted persisted task', async () => {
    const registry = new AutonomousToolRegistry();
    let calls = 0;
    registry.register(tool('resume-tool', async () => { calls += 1; return 'resumed'; }));
    const store = new MemoryTaskStore();
    const now = new Date().toISOString();
    const interrupted: AutonomousTaskRecord = {
      taskId: 'interrupted-task', goal: 'resume after restart', plan: plan('resume-tool'), currentStep: 0,
      executionState: 'running', errors: [], results: [], createdAt: now, updatedAt: now, startedAt: now,
      retryCount: 0, maxRetries: 2, planRevision: 1, memoryContext: [], auditEvents: [],
    };
    store.create(interrupted);
    const { instance } = runtime({ store, tools: registry });

    const task = await instance.resume(interrupted.taskId);

    expect(task.executionState).toBe('completed');
    expect(calls).toBe(1);
  });

  it('persists and resumes a task after reopening its SQLite database', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openarva-autonomous-'));
    const databasePath = join(directory, 'tasks.sqlite');
    const now = new Date().toISOString();
    const interrupted: AutonomousTaskRecord = {
      taskId: 'sqlite-restart-task', goal: 'resume from durable state', plan: plan('durable-tool'), currentStep: 0,
      executionState: 'running', errors: [], results: [], createdAt: now, updatedAt: now, startedAt: now,
      retryCount: 0, maxRetries: 2, planRevision: 1, memoryContext: [], auditEvents: [],
    };
    const firstStore = new SqliteAutonomousTaskStore(databasePath);
    firstStore.create(interrupted);
    firstStore.close?.();

    const registry = new AutonomousToolRegistry();
    registry.register(tool('durable-tool', async () => 'after restart'));
    const secondStore = new SqliteAutonomousTaskStore(databasePath);
    const { instance } = runtime({ store: secondStore, tools: registry });
    const verificationStore = new SqliteAutonomousTaskStore(databasePath);
    try {
      const task = await instance.resume(interrupted.taskId);
      expect(task.executionState).toBe('completed');
      expect(task.results[0]?.output).toBe('after restart');
      expect(verificationStore.get(interrupted.taskId)?.executionState).toBe('completed');
    } finally {
      verificationStore.close?.();
      secondStore.close?.();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not replay an uncertain external operation after SQLite restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openarva-operation-replay-'));
    const databasePath = join(directory, 'tasks.sqlite');
    const store = new SqliteAutonomousTaskStore(databasePath);
    const registry = new AutonomousToolRegistry();
    let externalCalls = 0;
    registry.register(tool('external.send', async () => {
      externalCalls += 1;
      throw new Error('connection lost after remote send');
    }, { permission: 'HIGH_RISK', idempotent: false }));
    const config = {
      store,
      tools: registry,
      planner: async () => plan('external.send'),
      verifier: async () => ({ verified: true, reason: 'not reached' }),
      approve: async () => true,
      maxReplans: 0,
      logger: () => undefined,
    };

    try {
      const firstRuntime = new AutonomousTaskRuntime(config);
      const task = await firstRuntime.run('send an external message');
      expect(task.executionState).toBe('failed');
      expect(externalCalls).toBe(1);
      store.close?.();

      const reopenedStore = new SqliteAutonomousTaskStore(databasePath);
      try {
        const restartedRuntime = new AutonomousTaskRuntime({ ...config, store: reopenedStore });
        const resumed = await restartedRuntime.resume(task.taskId);
        expect(resumed.executionState).toBe('failed');
        expect(resumed.errors.join(' ')).toContain('refusing duplicate execution');
        expect(externalCalls).toBe(1);
      } finally {
        reopenedStore.close?.();
      }
    } finally {
      if (externalCalls === 0) store.close?.();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('enforces the maximum retry budget', async () => {
    const registry = new AutonomousToolRegistry();
    let calls = 0;
    registry.register(tool('always-fails', async () => { calls += 1; throw new Error('persistent failure'); }));
    const { instance } = runtime({ tools: registry, maxRetries: 2, maxReplans: 0 });

    const task = await instance.run('bounded retry');

    expect(task.executionState).toBe('failed');
    expect(calls).toBe(3);
    expect(task.retryCount).toBe(2);
  });

  it('aborts a timed-out tool and records the failure', async () => {
    const registry = new AutonomousToolRegistry();
    registry.register(tool('slow', async (_input, { signal }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve('aborted'));
    }), { idempotent: false }));
    const { instance } = runtime({ tools: registry, defaultTimeoutMs: 5, maxReplans: 0 });

    const task = await instance.run('timeout safely');

    expect(task.executionState).toBe('failed');
    expect(task.errors.join(' ')).toContain('timed out');
  });

  it('rejects invalid tool inputs and local network URLs before execution', () => {
    expect(() => autonomousToolSchemas.workspaceEdit.parse({ path: '../outside.txt', content: 'x', unexpected: true })).toThrow();
    expect(() => autonomousToolSchemas.webFetch.parse({ url: 'http://127.0.0.1/admin' })).toThrow();
  });

  it('bounds large tool results before persisting them', async () => {
    const registry = new AutonomousToolRegistry();
    registry.register(tool('large-output', async () => 'x'.repeat(150_000)));
    const { instance } = runtime({ tools: registry });

    const task = await instance.run('store a bounded result');
    const output = task.results[0]?.output as { truncated?: boolean; originalBytes?: number; preview?: string };

    expect(output.truncated).toBe(true);
    expect(output.originalBytes).toBeGreaterThan(100_000);
    expect(output.preview?.length).toBe(100_000);
  });

  it('completes an end-to-end plan with structured verification and lifecycle logs', async () => {
    const registry = new AutonomousToolRegistry();
    registry.register(tool('research', async () => ({ finding: 'local result' })));
    registry.register(tool('summarize', async ({ value }) => `summary:${value}`));
    const events: string[] = [];
    const { instance } = runtime({
      tools: registry,
      planner: async () => [
        { id: 'research', tool: 'research', objective: 'collect evidence', input: { value: 'sources' } },
        { id: 'summarize', tool: 'summarize', objective: 'summarize evidence', input: { value: 'evidence' } },
      ],
      verifier: async ({ results }) => ({ verified: results.length === 2, reason: 'both steps completed' }),
      logger: (event) => events.push(String(event.event)),
    });

    const task = await instance.run('research and summarize');

    expect(task.executionState).toBe('completed');
    expect(task.results).toHaveLength(2);
    expect(events).toContain('plan_created');
    expect(events).toContain('verification');
    expect(events).toContain('task_completed');
  });
});