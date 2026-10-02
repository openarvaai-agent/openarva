import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { confirmAutonomousExecutionApproval } from '../commands/state.js';
import { recordAudit } from '../security/privacy.js';

export const toolRiskLevels = ['READ_ONLY', 'SAFE', 'MODERATE', 'HIGH_RISK'] as const;
export type ToolRiskLevel = (typeof toolRiskLevels)[number];

export interface PolicyTool<Input = unknown, Output = unknown> {
  name: string;
  permission: ToolRiskLevel;
  inputSchema: z.ZodType<Input>;
  timeoutMs?: number;
  execute(input: Input, context: PolicyExecutionContext): Promise<Output> | Output;
}

export interface PolicyExecutionContext { taskId: string; signal: AbortSignal; operationId?: string; }

export interface ToolPolicyOptions {
  taskId: string;
  operationId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  approve?: (request: { taskId: string; tool: string; permission: ToolRiskLevel; objective: string; input: unknown }) => Promise<boolean> | boolean;
  objective?: string;
  idempotent?: boolean;
  journal?: ToolOperationJournal;
  onEvent?: (event: { event: string; taskId: string; tool: string; operationId?: string; permission: ToolRiskLevel; timestamp: string; error?: string }) => void | Promise<void>;
}

export type ToolOperationState = 'started' | 'succeeded' | 'failed' | 'indeterminate';
export interface ToolOperation { operationId: string; state: ToolOperationState; result?: unknown; error?: string; }
export interface ToolOperationJournal {
  getOperation(operationId: string): ToolOperation | null;
  begin(operationId: string, tool: string, allowFailedRetry?: boolean): boolean;
  finish(operationId: string, state: Exclude<ToolOperationState, 'started'>, result?: unknown, error?: string): void;
}

export class SqliteToolOperationJournal implements ToolOperationJournal {
  private readonly database: InstanceType<typeof Database>;

  constructor(databasePath = process.env.OPENARVA_AUTONOMOUS_DB || join(homedir(), '.openarva', 'autonomous-tasks.sqlite')) {
    if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new Database(databasePath);
    this.database.exec(`CREATE TABLE IF NOT EXISTS tool_operations (
      operation_id TEXT PRIMARY KEY,
      tool TEXT NOT NULL,
      state TEXT NOT NULL,
      result_json TEXT,
      error TEXT,
      updated_at TEXT NOT NULL
    )`);
  }

  getOperation(operationId: string) {
    const row = this.database.prepare('SELECT operation_id, state, result_json, error FROM tool_operations WHERE operation_id = ?').get(operationId) as { operation_id: string; state: ToolOperationState; result_json?: string; error?: string } | undefined;
    if (!row) return null;
    return { operationId: row.operation_id, state: row.state, result: row.result_json ? JSON.parse(row.result_json) : undefined, error: row.error };
  }

  begin(operationId: string, tool: string, allowFailedRetry = false) {
    const now = new Date().toISOString();
    const inserted = this.database.prepare(`INSERT OR IGNORE INTO tool_operations (operation_id, tool, state, updated_at)
      VALUES (?, ?, 'started', ?)`).run(operationId, tool, now);
    if (inserted.changes === 1) return true;
    if (!allowFailedRetry) return false;
    const retried = this.database.prepare(`UPDATE tool_operations SET state = 'started', result_json = NULL, error = NULL, updated_at = ?
      WHERE operation_id = ? AND tool = ? AND state = 'failed'`).run(now, operationId, tool);
    return retried.changes === 1;
  }

  finish(operationId: string, state: Exclude<ToolOperationState, 'started'>, result?: unknown, error?: string) {
    const serialized = result === undefined ? null : JSON.stringify(result);
    this.database.prepare('UPDATE tool_operations SET state = ?, result_json = ?, error = ?, updated_at = ? WHERE operation_id = ?')
      .run(state, serialized, error || null, new Date().toISOString(), operationId);
  }
}

let defaultOperationJournal: SqliteToolOperationJournal | undefined;
const trustedExecutionContexts = new WeakSet<object>();
export function isPolicyExecutionContext(context: unknown): context is PolicyExecutionContext {
  return typeof context === 'object' && context !== null && trustedExecutionContexts.has(context);
}

function boundToolResult(result: unknown, maximumBytes = 100_000) {
  if (result === undefined) return null;
  let serialized: string;
  try { serialized = JSON.stringify(result); } catch { return { unrepresentable: true }; }
  const size = Buffer.byteLength(serialized, 'utf8');
  return size <= maximumBytes ? result : { truncated: true, originalBytes: size, preview: serialized.slice(0, maximumBytes) };
}

function getDefaultOperationJournal() {
  defaultOperationJournal ||= new SqliteToolOperationJournal();
  return defaultOperationJournal;
}

export async function runToolWithSafetyPolicy<Input, Output>(tool: PolicyTool<Input, Output>, rawInput: unknown, options: ToolPolicyOptions): Promise<Output> {
  const input = tool.inputSchema.parse(rawInput);
  const journal = options.journal || getDefaultOperationJournal();
  const emit = async (event: string, error?: unknown) => {
    const message = error instanceof Error ? error.message : error === undefined ? undefined : String(error);
    const item = {
      event,
      taskId: options.taskId,
      tool: tool.name,
      operationId: options.operationId,
      permission: tool.permission,
      timestamp: new Date().toISOString(),
      ...(message ? { error: message } : {}),
    };
    recordAudit(`tool:${event}`, JSON.stringify({ taskId: item.taskId, tool: item.tool, operationId: item.operationId, permission: item.permission, error: item.error }));
    await options.onEvent?.(item);
  };

  if (options.operationId) {
    const existing = journal.getOperation(options.operationId);
    if (existing?.state === 'succeeded') return existing.result as Output;
    if (existing?.state === 'started' || existing?.state === 'indeterminate') {
      throw new Error(`Operation ${options.operationId} has uncertain external completion; refusing duplicate execution. Reconcile manually before resuming.`);
    }
    if (existing?.state === 'failed' && !options.idempotent) {
      throw new Error(`Operation ${options.operationId} previously failed and is not idempotent; refusing duplicate execution.`);
    }
  }

  if (tool.permission === 'MODERATE' || tool.permission === 'HIGH_RISK') {
    await emit('approval_requested');
    const approved = await options.approve?.({
      taskId: options.taskId,
      tool: tool.name,
      permission: tool.permission,
      objective: options.objective || tool.name,
      input,
    }) ?? await confirmAutonomousExecutionApproval(`${tool.permission} ${tool.name} - ${options.objective || tool.name}\nValidated arguments: ${JSON.stringify(input).slice(0, 2000)}`);
    if (!approved) {
      await emit('permission_denied');
      throw new Error(`Permission denied for ${tool.permission} tool ${tool.name}.`);
    }
    await emit('permission_approved');
  }

  const timeoutMs = Math.max(1, Math.min(15 * 60_000, options.timeoutMs ?? tool.timeoutMs ?? 30_000));
  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener('abort', onAbort, { once: true });

  if (controller.signal.aborted) {
    options.signal?.removeEventListener('abort', onAbort);
    await emit('tool_cancelled_or_timed_out', new Error('Tool execution was cancelled.'));
    throw new Error('Tool execution was cancelled.');
  }
  if (options.operationId && !journal.begin(options.operationId, tool.name, options.idempotent === true)) {
    options.signal?.removeEventListener('abort', onAbort);
    await emit('operation_claim_denied', new Error('Operation is already claimed or cannot be safely retried.'));
    throw new Error(`Operation ${options.operationId} is already claimed or cannot be safely retried.`);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error(`Tool timed out after ${timeoutMs}ms.`));
      reject(new Error(`Tool timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
  });

  try {
    if (controller.signal.aborted) throw new Error('Tool execution was cancelled.');
    await emit('tool_started');
    const context: PolicyExecutionContext = { taskId: options.taskId, signal: controller.signal, operationId: options.operationId };
    trustedExecutionContexts.add(context);
    const rawResult = await Promise.race([
      Promise.resolve().then(() => tool.execute(input, context)),
      timeout,
    ]).finally(() => trustedExecutionContexts.delete(context));
    const result = boundToolResult(rawResult) as Output;
    if (options.operationId) journal.finish(options.operationId, 'succeeded', result);
    await emit('tool_succeeded');
    return result;
  } catch (error) {
    if (options.operationId) journal.finish(options.operationId, options.idempotent ? 'failed' : 'indeterminate', undefined, error instanceof Error ? error.message : String(error));
    await emit(controller.signal.aborted ? 'tool_cancelled_or_timed_out' : 'tool_failed', error);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}