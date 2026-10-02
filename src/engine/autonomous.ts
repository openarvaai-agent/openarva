import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { runToolWithSafetyPolicy, toolRiskLevels, type ToolRiskLevel, type ToolOperation, type ToolOperationJournal } from '../tools/executionPolicy.js';

export const permissionLevels = toolRiskLevels;
export type PermissionLevel = ToolRiskLevel;
export type AutonomousState = 'queued' | 'planning' | 'running' | 'verifying' | 'completed' | 'failed';

export interface AutonomousPlanStep {
  id: string;
  tool: string;
  objective: string;
  input: unknown;
}

export interface AutonomousTaskRecord {
  taskId: string;
  goal: string;
  plan: AutonomousPlanStep[];
  currentStep: number;
  executionState: AutonomousState;
  errors: string[];
  results: Array<{ stepId: string; tool: string; output: unknown }>;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  retryCount: number;
  maxRetries: number;
  planRevision: number;
  memoryContext: string[];
  auditEvents: Array<Record<string, unknown>>;
  verification?: string;
}

export interface ToolExecutionContext {
  taskId: string;
  signal: AbortSignal;
}

export interface AutonomousTool<Input = unknown, Output = unknown> {
  name: string;
  description: string;
  inputSchemaHint?: string;
  permission: PermissionLevel;
  inputSchema: z.ZodType<Input>;
  idempotent?: boolean;
  timeoutMs?: number;
  execute(input: Input, context: ToolExecutionContext): Promise<Output> | Output;
}

export class AutonomousToolRegistry {
  private readonly tools = new Map<string, AutonomousTool>();

  register(tool: AutonomousTool) {
    if (!tool.name.trim()) throw new Error('Tool name is required.');
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  get(name: string) { return this.tools.get(name); }
  list() { return [...this.tools.values()]; }
}

export interface AutonomousTaskStore extends ToolOperationJournal {
  create(task: AutonomousTaskRecord): void;
  get(taskId: string): AutonomousTaskRecord | null;
  save(task: AutonomousTaskRecord): void;
  listRecoverable(): AutonomousTaskRecord[];
  close?(): void;
}

export class SqliteAutonomousTaskStore implements AutonomousTaskStore, ToolOperationJournal {
  private readonly database: InstanceType<typeof Database>;

  constructor(databasePath = process.env.OPENARVA_AUTONOMOUS_DB || join(homedir(), '.openarva', 'autonomous-tasks.sqlite')) {
    if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new Database(databasePath);
    this.database.exec(`CREATE TABLE IF NOT EXISTS autonomous_tasks (
      task_id TEXT PRIMARY KEY,
      record_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      execution_state TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS idx_autonomous_tasks_state ON autonomous_tasks(execution_state);
    CREATE TABLE IF NOT EXISTS tool_operations (
      operation_id TEXT PRIMARY KEY, tool TEXT NOT NULL, state TEXT NOT NULL, result_json TEXT, error TEXT, updated_at TEXT NOT NULL
    );`);
  }

  create(task: AutonomousTaskRecord) {
    this.database.prepare('INSERT INTO autonomous_tasks (task_id, record_json, updated_at, execution_state) VALUES (?, ?, ?, ?)')
      .run(task.taskId, JSON.stringify(task), task.updatedAt, task.executionState);
  }

  get(taskId: string) {
    const row = this.database.prepare('SELECT record_json FROM autonomous_tasks WHERE task_id = ?').get(taskId) as { record_json: string } | undefined;
    return row ? JSON.parse(row.record_json) as AutonomousTaskRecord : null;
  }

  save(task: AutonomousTaskRecord) {
    this.database.prepare('INSERT OR REPLACE INTO autonomous_tasks (task_id, record_json, updated_at, execution_state) VALUES (?, ?, ?, ?)')
      .run(task.taskId, JSON.stringify(task), task.updatedAt, task.executionState);
  }

  listRecoverable() {
    const rows = this.database.prepare("SELECT record_json FROM autonomous_tasks WHERE execution_state NOT IN ('completed', 'failed') ORDER BY updated_at").all() as Array<{ record_json: string }>;
    return rows.map((row) => JSON.parse(row.record_json) as AutonomousTaskRecord);
  }

  getOperation(operationId: string): ToolOperation | null {
    const row = this.database.prepare('SELECT operation_id, state, result_json, error FROM tool_operations WHERE operation_id = ?').get(operationId) as { operation_id: string; state: ToolOperation['state']; result_json?: string; error?: string } | undefined;
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

  finish(operationId: string, state: Exclude<ToolOperation['state'], 'started'>, result?: unknown, error?: string) {
    this.database.prepare('UPDATE tool_operations SET state = ?, result_json = ?, error = ?, updated_at = ? WHERE operation_id = ?')
      .run(state, result === undefined ? null : JSON.stringify(result), error || null, new Date().toISOString(), operationId);
  }

  close() { this.database.close(); }
}

export interface PlannerContext {
  goal: string;
  memory: string[];
  previousResults: AutonomousTaskRecord['results'];
  errors: string[];
  previousPlan: AutonomousPlanStep[];
  revision: number;
  availableTools: Array<{ name: string; description: string; inputSchemaHint?: string; permission: PermissionLevel; inputSchema: z.ZodType }>
}

export interface VerificationResult {
  verified: boolean;
  reason: string;
}

export interface AutonomousRuntimeOptions {
  store?: AutonomousTaskStore;
  planner: (context: PlannerContext) => Promise<AutonomousPlanStep[]>;
  verifier: (input: { goal: string; plan: AutonomousPlanStep[]; results: AutonomousTaskRecord['results'] }) => Promise<VerificationResult>;
  tools?: AutonomousToolRegistry;
  approve?: (input: { taskId: string; tool: string; permission: PermissionLevel; objective: string; input: unknown }) => Promise<boolean> | boolean;
  retrieveMemory?: (goal: string) => Promise<string[]> | string[];
  recordMemory?: (task: AutonomousTaskRecord, outcome: 'completed' | 'failed') => Promise<void> | void;
  logger?: (event: Record<string, unknown>) => void;
  maxRetries?: number;
  maxReplans?: number;
  maxSteps?: number;
  defaultTimeoutMs?: number;
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number) {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function boundToolOutput(output: unknown, maxBytes = 100_000) {
  if (output === undefined) return null;
  let serialized: string;
  try {
    serialized = JSON.stringify(output);
  } catch {
    return { unrepresentable: true };
  }
  const originalBytes = Buffer.byteLength(serialized, 'utf8');
  if (originalBytes <= maxBytes) return output;
  return { truncated: true, originalBytes, preview: serialized.slice(0, maxBytes) };
}

export class AutonomousTaskRuntime {
  private readonly store: AutonomousTaskStore;
  private readonly tools: AutonomousToolRegistry;
  private readonly maxRetries: number;
  private readonly maxReplans: number;
  private readonly maxSteps: number;
  private readonly defaultTimeoutMs: number;

  constructor(private readonly options: AutonomousRuntimeOptions) {
    this.store = options.store || new SqliteAutonomousTaskStore();
    this.tools = options.tools || new AutonomousToolRegistry();
    this.maxRetries = boundedInteger(options.maxRetries, 2, 0, 5);
    this.maxReplans = boundedInteger(options.maxReplans, 1, 0, 3);
    this.maxSteps = boundedInteger(options.maxSteps, 10, 1, 50);
    this.defaultTimeoutMs = boundedInteger(options.defaultTimeoutMs, 30_000, 1, 15 * 60_000);
  }

  async run(goal: string) {
    if (!goal.trim()) throw new Error('A task goal is required.');
    const now = new Date().toISOString();
    const task: AutonomousTaskRecord = {
      taskId: randomUUID(), goal: goal.trim(), plan: [], currentStep: 0, executionState: 'queued', errors: [], results: [],
      createdAt: now, updatedAt: now, startedAt: now, retryCount: 0, maxRetries: this.maxRetries, planRevision: 0, memoryContext: [],
      auditEvents: [],
    };
    this.store.create(task);
    this.log('task_started', task, { goalLength: task.goal.length });
    return this.execute(task);
  }

  async resume(taskId: string) {
    const task = this.store.get(taskId);
    if (!task) throw new Error(`Autonomous task not found: ${taskId}`);
    if (task.executionState === 'completed') return task;
    task.executionState = task.plan.length ? 'running' : 'queued';
    this.persist(task);
    this.log('task_recovery', task, { currentStep: task.currentStep });
    return this.execute(task);
  }

  async resumeRecoverable() {
    const tasks = this.store.listRecoverable();
    const resumed: AutonomousTaskRecord[] = [];
    for (const task of tasks) resumed.push(await this.resume(task.taskId));
    return resumed;
  }

  getTask(taskId: string) { return this.store.get(taskId); }

  async executeTool(toolName: string, input: unknown, context: { taskId?: string; operationId?: string; signal?: AbortSignal; objective?: string } = {}) {
    const tool = this.tools.get(toolName);
    if (!tool) throw new Error(`Unknown tool: ${toolName}`);
    const taskId = context.taskId || randomUUID();
    const operationId = context.operationId || `${taskId}:${toolName}:${randomUUID()}`;
    return runToolWithSafetyPolicy(tool, input, {
      taskId,
      operationId,
      signal: context.signal,
      timeoutMs: tool.timeoutMs ?? this.defaultTimeoutMs,
      objective: context.objective,
      approve: this.options.approve,
      idempotent: tool.idempotent,
      journal: this.store,
      onEvent: (event) => {
        if (this.options.logger) this.options.logger(event);
        else console.log(JSON.stringify(event));
      },
    });
  }

  private async execute(task: AutonomousTaskRecord): Promise<AutonomousTaskRecord> {
    try {
      if (!task.memoryContext.length && this.options.retrieveMemory) task.memoryContext = await this.options.retrieveMemory(task.goal);
      let shouldPlan = !task.plan.length;

      while (true) {
        if (shouldPlan) {
          task.executionState = 'planning';
          this.persist(task);
          const previousPlan = task.plan;
          const plan = await this.options.planner({
            goal: task.goal,
            memory: task.memoryContext,
            previousResults: task.results,
            errors: task.errors,
            previousPlan,
            revision: task.planRevision,
            availableTools: this.tools.list().map(({ name, description, inputSchemaHint, permission, inputSchema }) => ({ name, description, inputSchemaHint, permission, inputSchema })),
          });
          if (!Array.isArray(plan) || !plan.length || plan.length > this.maxSteps) throw new Error(`Planner must return 1-${this.maxSteps} steps.`);
          task.plan = plan.map((step, index) => ({ ...step, id: step.id || `${task.planRevision}-${index + 1}` }));
          task.currentStep = 0;
          task.planRevision += 1;
          task.executionState = 'running';
          this.persist(task);
          this.log('plan_created', task, { revision: task.planRevision, stepCount: task.plan.length });
        }

        let needsReplan = false;
        for (; task.currentStep < task.plan.length; task.currentStep += 1) {
          const step = task.plan[task.currentStep];
          const tool = this.tools.get(step.tool);
          if (!tool) throw new Error(`Plan references unknown tool: ${step.tool}`);
          const input = tool.inputSchema.parse(step.input);
          this.log('step_started', task, { stepId: step.id, tool: tool.name, index: task.currentStep });

          let output: unknown;
          let lastError: unknown;
          const retryLimit = tool.idempotent ? task.maxRetries : 0;
          for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
            try {
              output = boundToolOutput(await runToolWithSafetyPolicy(tool, input, {
                taskId: task.taskId,
                operationId: `${task.taskId}:${task.planRevision}:${step.id}`,
                timeoutMs: tool.timeoutMs ?? this.defaultTimeoutMs,
                objective: step.objective,
                approve: this.options.approve,
                idempotent: tool.idempotent,
                journal: this.store,
                onEvent: (event) => this.log(event.event, task, { stepId: step.id, attempt: attempt + 1, operationId: event.operationId, permission: event.permission, error: event.error }),
              }));
              this.log('tool_result', task, { stepId: step.id, tool: tool.name, attempt: attempt + 1, ok: true, outputType: output === null ? 'null' : Array.isArray(output) ? 'array' : typeof output });
              lastError = undefined;
              break;
            } catch (error) {
              lastError = error;
              task.retryCount += attempt < retryLimit ? 1 : 0;
              this.log('tool_result', task, { stepId: step.id, tool: tool.name, attempt: attempt + 1, ok: false, error: error instanceof Error ? error.message : String(error) });
              if (attempt < retryLimit) {
                this.log('recovery', task, { stepId: step.id, retry: attempt + 1, maxRetries: retryLimit });
                continue;
              }
            }
          }

          if (lastError !== undefined) {
            const message = lastError instanceof Error ? lastError.message : String(lastError);
            task.errors.push(message);
            this.log('failure', task, { stepId: step.id, error: message });
            if (task.planRevision <= this.maxReplans && tool.permission !== 'HIGH_RISK') {
              task.executionState = 'planning';
              task.plan = [];
              task.currentStep = 0;
              needsReplan = true;
              this.log('replan', task, { reason: message, nextRevision: task.planRevision });
              break;
            }
            return this.fail(task, message);
          }

          task.results.push({ stepId: step.id, tool: tool.name, output });
          task.currentStep += 1;
          this.persist(task);
          task.currentStep -= 1;
        }

        if (needsReplan) {
          shouldPlan = true;
          continue;
        }

        task.executionState = 'verifying';
        this.persist(task);
        const verification = await this.options.verifier({ goal: task.goal, plan: task.plan, results: task.results });
        task.verification = verification.reason;
        this.log('verification', task, { verified: verification.verified, reason: verification.reason });
        if (verification.verified) {
          task.executionState = 'completed';
          task.completedAt = new Date().toISOString();
          task.updatedAt = task.completedAt;
          this.store.save(task);
          await this.recordMemory(task, 'completed');
          this.log('task_completed', task, { resultCount: task.results.length });
          return task;
        }

        task.errors.push(`Verification failed: ${verification.reason}`);
        if (task.planRevision <= this.maxReplans) {
          task.executionState = 'planning';
          task.plan = [];
          task.currentStep = 0;
          shouldPlan = true;
          this.log('replan', task, { reason: verification.reason, nextRevision: task.planRevision });
          continue;
        }
        return this.fail(task, `Verification failed: ${verification.reason}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      task.errors.push(message);
      return this.fail(task, message);
    }
  }

  private async fail(task: AutonomousTaskRecord, error: string) {
    task.executionState = 'failed';
    task.updatedAt = new Date().toISOString();
    this.store.save(task);
    await this.recordMemory(task, 'failed');
    this.log('failure', task, { error });
    return task;
  }

  private async recordMemory(task: AutonomousTaskRecord, outcome: 'completed' | 'failed') {
    if (!this.options.recordMemory) return;
    try {
      await this.options.recordMemory(task, outcome);
    } catch (error) {
      this.log('memory_index_failed', task, { outcome, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private log(event: string, task: AutonomousTaskRecord, details: Record<string, unknown> = {}) {
    const entry = { timestamp: new Date().toISOString(), event, taskId: task.taskId, state: task.executionState, ...details };
    task.auditEvents.push(entry);
    this.store.save(task);
    if (this.options.logger) this.options.logger(entry);
    else console.log(JSON.stringify(entry));
  }

  private persist(task: AutonomousTaskRecord) {
    task.updatedAt = new Date().toISOString();
    this.store.save(task);
  }
}

export const autonomousToolSchemas = {
  empty: z.object({}).strict(),
  workspaceSearch: z.object({ query: z.string().min(1), cwd: z.string().optional() }).strict(),
  workspaceEdit: z.object({ path: z.string().min(1), content: z.string(), cwd: z.string().optional() }).strict(),
  command: z.object({ command: z.string().min(1), cwd: z.string().optional() }).strict(),
  memorySearch: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(20).optional() }).strict(),
  screenshot: z.object({ outputPath: z.string().optional() }).strict(),
  imageAnalysis: z.object({ imagePath: z.string().min(1), prompt: z.string().min(1).max(4000) }).strict(),
  githubCrawl: z.object({ repository: z.string().min(3) }).strict(),
  assistantRespond: z.object({
    prompt: z.string().min(1),
    domain: z.enum(['coding', 'agriculture', 'accounting', 'documents', 'research', 'engineering', 'medicine']).optional(),
  }).strict(),
  webFetch: z.object({
    url: z.string().url().refine((value) => {
      const parsed = new URL(value);
      return ['http:', 'https:'].includes(parsed.protocol)
        && !parsed.username && !parsed.password
        && !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname.toLowerCase())
        && !/^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(parsed.hostname);
    }, 'URL must use HTTP(S) and must not target localhost or a private IPv4 address.'),
  }).strict(),
  telegramSend: z.object({ recipientId: z.string().optional(), text: z.string().min(1).max(4096) }).strict(),
  whatsappSend: z.object({ recipientId: z.string().min(1), text: z.string().min(1).max(4096) }).strict(),
};