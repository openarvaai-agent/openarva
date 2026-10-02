import { routeAiCompletion, type AiTaskCapability } from '../ai/providers.js';
import { OpenArvaRouter } from '../ai/router.js';
import chalk from 'chalk';
import { addTask, confirmAutonomousExecutionApproval, confirmExecutionApproval, updateTaskStatus } from '../commands/state.js';
import { OpenArvaMemory } from '../db/memory.js';
import { executeSystemCommand, getSystemStatus, inspectProcesses, takeScreenshot } from '../tools/system.js';
import { editWorkspaceFile, executeWorkspaceCommand, searchWorkspace } from '../tools/workspace.js';
import { indexMemoryDocumentAsync, indexTaskExecution, searchMemoryAsync } from '../memory/vectorStore.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { scrapeWebPage } from '../tools/browser.js';
import { crawlGitHub } from '../crawlers/gitcrawl.js';
import { routeAiVisionCompletion } from '../ai/providers.js';
import { TelegramConnector } from '../connectors/telegram.js';
import { WhatsAppConnector } from '../connectors/whatsapp.js';
import {
  AutonomousTaskRuntime,
  AutonomousToolRegistry,
  autonomousToolSchemas,
  type AutonomousPlanStep,
} from './autonomous.js';

export type NativeToolName = 'system.status' | 'system.processes' | 'system.screenshot' | 'system.exec' | 'workspace.search' | 'workspace.edit' | 'workspace.exec';

function renderDiffPreview(before: string, after: string) {
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  const max = Math.max(beforeLines.length, afterLines.length);

  console.log(chalk.cyan.bold('Diff Preview'));
  for (let i = 0; i < max; i += 1) {
    const oldLine = beforeLines[i] ?? '';
    const newLine = afterLines[i] ?? '';

    if (oldLine === newLine) {
      console.log(chalk.dim(`  ${i + 1}  ${oldLine}`));
      continue;
    }

    if (oldLine && newLine) {
      console.log(chalk.red(`- ${i + 1}  ${oldLine}`));
      console.log(chalk.green(`+ ${i + 1}  ${newLine}`));
    } else if (newLine) {
      console.log(chalk.green(`+ ${i + 1}  ${newLine}`));
    } else {
      console.log(chalk.red(`- ${i + 1}  ${oldLine}`));
    }
  }
}

export interface AgentTask {
  domain: 'coding' | 'agriculture' | 'accounting' | 'documents' | 'research' | 'engineering' | 'medicine';
  instruction: string;
}

function capabilityForDomain(domain: AgentTask['domain']): AiTaskCapability {
  if (domain === 'coding') return 'coding';
  if (domain === 'research' || domain === 'medicine' || domain === 'agriculture') return 'research';
  if (domain === 'engineering' || domain === 'accounting') return 'reasoning';
  return 'fast';
}

function extractJson(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  return fenced?.trim() || text.match(/\[[\s\S]*\]|\{[\s\S]*\}/)?.[0] || text.trim();
}

export class OpenArvaAgent {
  private memory = new OpenArvaMemory();
  private readonly autonomousTools = new AutonomousToolRegistry();
  private readonly telegramConnector = new TelegramConnector();
  private readonly whatsappConnector = new WhatsAppConnector();
  private autonomousRuntime?: AutonomousTaskRuntime;
  private autonomousToolsInitialized = false;

  private systemPersona = `
    You are OpenArva, a configurable assistant runtime.
    Use only capabilities that are actually available through the current tools and configured providers.
    Never claim that an integration, file edit, command, research action, or external message succeeded without tool evidence.
    Be explicit when a requested capability is unavailable or marked as a placeholder.
  `;

  private initializeAutonomousTools() {
    if (this.autonomousToolsInitialized) return;
    this.autonomousToolsInitialized = true;
    const tools = this.autonomousTools;
    tools.register({
      name: 'workspace.search', description: 'Search project files for a text or regular expression.',
      inputSchemaHint: '{ "query": string, "cwd"?: string }', permission: 'READ_ONLY', inputSchema: autonomousToolSchemas.workspaceSearch,
      execute: ({ query, cwd }) => searchWorkspace(query, cwd || process.cwd()),
    });
    tools.register({
      name: 'memory.search', description: 'Retrieve relevant local OpenArva memory entries.',
      inputSchemaHint: '{ "query": string, "limit"?: integer (1..20) }', permission: 'READ_ONLY', inputSchema: autonomousToolSchemas.memorySearch,
      execute: ({ query, limit }) => searchMemoryAsync(query, limit || 5),
    });
    tools.register({
      name: 'system.status', description: 'Read operating system and runtime status.', inputSchemaHint: '{}',
      permission: 'READ_ONLY', inputSchema: autonomousToolSchemas.empty, execute: () => getSystemStatus(),
    });
    tools.register({
      name: 'system.processes', description: 'List running processes without modifying them.', inputSchemaHint: '{}',
      permission: 'READ_ONLY', inputSchema: autonomousToolSchemas.empty, execute: () => inspectProcesses(),
    });
    tools.register({
      name: 'system.screenshot', description: 'Capture a screenshot to a local image file.',
      inputSchemaHint: '{ "outputPath"?: string }', permission: 'MODERATE', inputSchema: autonomousToolSchemas.screenshot,
      execute: ({ outputPath }, context) => takeScreenshot(outputPath || 'openarva-screenshot.png', context),
    });
    tools.register({
      name: 'assistant.respond', description: 'Answer a user request using the configured task-appropriate model.',
      inputSchemaHint: '{ "prompt": string, "domain"?: domain }', permission: 'SAFE', inputSchema: autonomousToolSchemas.assistantRespond,
      execute: ({ prompt, domain }) => this.respond(prompt, domain || 'coding'),
    });
    tools.register({
      name: 'github.crawl', description: 'Index GitHub repository metadata, issues, pull requests, and commits.',
      inputSchemaHint: '{ "repository": "owner/name" }', permission: 'MODERATE', inputSchema: autonomousToolSchemas.githubCrawl,
      execute: ({ repository }, { signal }) => crawlGitHub({ repository, token: process.env.GITHUB_TOKEN, signal }), timeoutMs: 90_000, idempotent: true,
    });
    tools.register({
      name: 'vision.analyze', description: 'Analyze a local image with the configured multimodal provider.',
      inputSchemaHint: '{ "imagePath": string, "prompt": string }', permission: 'MODERATE', inputSchema: autonomousToolSchemas.imageAnalysis,
      execute: async ({ imagePath, prompt }, { signal }) => {
        const imagePathResolved = resolve(imagePath);
        const mimeTypeByExtension: Record<string, string> = {
          '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
        };
        const mimeType = mimeTypeByExtension[extname(imagePathResolved).toLowerCase()];
        if (!mimeType) throw new Error('Image must be PNG, JPEG, WebP, or GIF.');
        const image = await readFile(imagePathResolved);
        if (image.byteLength > 10 * 1024 * 1024) throw new Error('Image exceeds the 10 MB analysis limit.');
        const result = await routeAiVisionCompletion(prompt, image, mimeType, signal);
        return { provider: result.route.provider, model: result.route.model, text: result.text };
      },
      timeoutMs: 90_000, idempotent: false,
    });
    tools.register({
      name: 'workspace.edit', description: 'Create or replace a file inside the current workspace.',
      inputSchemaHint: '{ "path": string, "content": string, "cwd"?: string }', permission: 'MODERATE', inputSchema: autonomousToolSchemas.workspaceEdit,
      execute: ({ path, content, cwd }, context) => editWorkspaceFile(path, content, cwd || process.cwd(), context),
    });
    tools.register({
      name: 'workspace.exec', description: 'Run an allowlisted command in the workspace sandbox.',
      inputSchemaHint: '{ "command": string, "cwd"?: string }', permission: 'HIGH_RISK', inputSchema: autonomousToolSchemas.command,
      execute: ({ command, cwd }, context) => executeWorkspaceCommand(command, cwd || process.cwd(), context), idempotent: false,
    });
    tools.register({
      name: 'system.exec', description: 'Run an allowlisted system command in the workspace sandbox.',
      inputSchemaHint: '{ "command": string, "cwd"?: string }', permission: 'HIGH_RISK', inputSchema: autonomousToolSchemas.command,
      execute: ({ command, cwd }, context) => executeSystemCommand(command, cwd || process.cwd(), context), idempotent: false,
    });
    tools.register({
      name: 'web.fetch', description: 'Fetch readable content from a public HTTP or HTTPS web page.',
      inputSchemaHint: '{ "url": string }', permission: 'READ_ONLY', inputSchema: autonomousToolSchemas.webFetch,
      execute: ({ url }, { signal }) => scrapeWebPage(url, signal), timeoutMs: 20_000, idempotent: true,
    });
    tools.register({
      name: 'messaging.telegram.send', description: 'Send a Telegram message through the configured OpenArva connector.',
      inputSchemaHint: '{ "recipientId"?: string, "text": string }', permission: 'HIGH_RISK', inputSchema: autonomousToolSchemas.telegramSend,
      execute: ({ recipientId, text }) => this.telegramConnector.send({ channel: 'telegram', recipientId: recipientId || process.env.TELEGRAM_CHAT_ID || '', text }), idempotent: false,
    });
    tools.register({
      name: 'messaging.whatsapp.send', description: 'Send a WhatsApp message through the configured Twilio connector.',
      inputSchemaHint: '{ "recipientId": string, "text": string }', permission: 'HIGH_RISK', inputSchema: autonomousToolSchemas.whatsappSend,
      execute: ({ recipientId, text }) => this.whatsappConnector.send({ channel: 'whatsapp', recipientId, text }), idempotent: false,
    });
  }

  registerAutonomousTool(tool: import('./autonomous.js').AutonomousTool) {
    this.initializeAutonomousTools();
    this.autonomousTools.register(tool);
  }

  private createAutonomousRuntime() {
    if (this.autonomousRuntime) return this.autonomousRuntime;
    this.initializeAutonomousTools();
    const tools = this.autonomousTools;

    this.autonomousRuntime = new AutonomousTaskRuntime({
      tools,
      maxRetries: Number(process.env.OPENARVA_AUTONOMOUS_MAX_RETRIES || 2),
      maxReplans: Number(process.env.OPENARVA_AUTONOMOUS_MAX_REPLANS || 1),
      maxSteps: Number(process.env.OPENARVA_AUTONOMOUS_MAX_STEPS || 10),
      defaultTimeoutMs: Number(process.env.OPENARVA_AUTONOMOUS_TOOL_TIMEOUT_MS || 30_000),
      retrieveMemory: async (goal) => (await searchMemoryAsync(goal, 5)).filter((item) => item.score > 0).map((item) => `[${item.source}] ${item.text}`),
      recordMemory: (task, outcome) => indexTaskExecution(task, outcome),
      approve: ({ tool, permission, objective, input }) => confirmAutonomousExecutionApproval(`${permission} ${tool} - ${objective}\nValidated arguments: ${JSON.stringify(input).slice(0, 2000)}`),
      logger: (event) => console.log(JSON.stringify(event)),
      planner: async (context) => {
        const route = OpenArvaRouter.resolveTaskRoute('reasoning');
        const answer = await routeAiCompletion([
          'Create a minimal executable plan for the user goal using only the listed tools.',
          'Return only a JSON array. Each item must have keys id, tool, objective, input.',
          'Do not invent tools. Keep the plan read-only unless a write is necessary for the goal.',
          `Goal: ${context.goal}`,
          `Retrieved memory: ${JSON.stringify(context.memory)}`,
          `Previous results: ${JSON.stringify(context.previousResults)}`,
          `Prior errors: ${JSON.stringify(context.errors)}`,
          `Plan revision: ${context.revision}`,
          `Available tools: ${JSON.stringify(context.availableTools.map(({ name, description, inputSchemaHint, permission }) => ({ name, description, inputSchemaHint, permission })))}`,
        ].join('\n\n'), route.provider, route.model);
        const parsed = z.array(z.object({
          id: z.string().optional(), tool: z.string().min(1), objective: z.string().min(1), input: z.record(z.unknown()).default({}),
        })).min(1).safeParse(JSON.parse(extractJson(answer)));
        if (!parsed.success) throw new Error(`Planner returned an invalid tool plan: ${parsed.error.message}`);
        return parsed.data as AutonomousPlanStep[];
      },
      verifier: async ({ goal, plan, results }) => {
        const route = OpenArvaRouter.resolveTaskRoute('reasoning');
        const answer = await routeAiCompletion([
          'Verify whether the task goal is satisfied by the tool results.',
          'Return only JSON: {"verified": boolean, "reason": string}. Never claim success if evidence is missing.',
          `Goal: ${goal}`,
          `Plan: ${JSON.stringify(plan)}`,
          `Results: ${JSON.stringify(results)}`,
        ].join('\n\n'), route.provider, route.model);
        const result = z.object({ verified: z.boolean(), reason: z.string() }).safeParse(JSON.parse(extractJson(answer)));
        if (!result.success) return { verified: false, reason: `Verifier returned invalid output: ${result.error.message}` };
        return result.data;
      },
    });
    return this.autonomousRuntime;
  }

  async executeAutonomousTask(goal: string) {
    return this.createAutonomousRuntime().run(goal);
  }

  async resumeAutonomousTask(taskId: string) {
    return this.createAutonomousRuntime().resume(taskId);
  }

  async resumeRecoverableAutonomousTasks() {
    return this.createAutonomousRuntime().resumeRecoverable();
  }

  async executeTask(task: AgentTask) {
    const taskRecord = addTask({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      title: task.instruction.slice(0, 80),
      description: task.instruction,
      status: 'in_progress',
      metadata: { domain: task.domain },
    });

    console.log(`[OpenArva Personal AI] Processing task for domain: ${task.domain}`);
    console.log(`Instruction: ${task.instruction.substring(0, 100)}...`);

    try {
      const retrievedMemories = await searchMemoryAsync(task.instruction, 5);
      const retrievedContext = retrievedMemories
        .filter((item) => item.score > 0)
        .map((item) => `[${item.source}] ${item.text}`)
        .join('\n');
      const route = OpenArvaRouter.resolveTaskRoute(capabilityForDomain(task.domain));
      console.log(`[Router] Selected: ${route.provider}/${route.model} for ${route.capability}`);

      if (task.instruction.startsWith('TOOL:')) {
        const call = JSON.parse(task.instruction.slice('TOOL:'.length).trim()) as { name?: NativeToolName; input?: Record<string, unknown> };
        const result = await this.executeNativeTool(call.name, call.input || {}, {
          taskId: taskRecord.id,
          operationId: `${taskRecord.id}:legacy:${call.name}`,
        });
        updateTaskStatus(taskRecord.id, 'completed');
        return JSON.stringify(result, null, 2);
      }

      if (task.instruction.startsWith('EXEC_CMD:')) {
        const cmd = task.instruction.replace('EXEC_CMD:', '').trim();
        const output = await this.executeNativeTool('workspace.exec', { command: cmd }, {
          taskId: taskRecord.id,
          operationId: `${taskRecord.id}:legacy:workspace.exec`,
        });
        updateTaskStatus(taskRecord.id, 'completed');
        return `✅ Command executed successfully:\n${JSON.stringify(output)}`;
      }

      const timestamp = new Date().toISOString();
      const recentContext = this.memory.getRecentContext(8);
      const personalizedPrompt = [
        this.systemPersona.trim(),
        recentContext ? `[RECENT CONVERSATION]\n${recentContext}\n[/RECENT CONVERSATION]` : '',
        retrievedContext ? `[RETRIEVED LOCAL MEMORY]\n${retrievedContext}\n[/RETRIEVED LOCAL MEMORY]` : '',
        `[CURRENT TASK]\nDomain: ${task.domain}\nRequest: ${task.instruction}\n[/CURRENT TASK]`,
        'Respond directly with a practical answer. Be transparent about what you can and cannot do.',
      ].filter(Boolean).join('\n\n');
      this.memory.saveConversation('user', task.instruction);
      const aiResult = await routeAiCompletion(personalizedPrompt, route.provider, route.model);
      this.memory.saveConversation('assistant', aiResult);
      renderDiffPreview('', aiResult);
      const approved = await confirmExecutionApproval(`execute task in ${task.domain}`);
      if (!approved) {
        updateTaskStatus(taskRecord.id, 'failed');
        return 'Preview approved? No action was taken.';
      }

      updateTaskStatus(taskRecord.id, 'completed');
      return `
🎯 OpenArva Autonomous Execution Complete
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Domain: ${task.domain}
Model Used: ${route.provider}/${route.model}
Timestamp: ${timestamp}
Status: ✅ Success
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${aiResult}
      `;
    } catch (error: any) {
      updateTaskStatus(taskRecord.id, 'failed');
      return `
❌ Error During Execution
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Domain: ${task.domain}
Error: ${error.message}
Suggestion: Please verify your input and try again.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      `;
    }
  }

  async executeNativeTool(name: NativeToolName | undefined, input: Record<string, unknown>, context: { taskId?: string; operationId?: string; signal?: AbortSignal } = {}) {
    const dispatch = (toolName: NativeToolName, toolInput: unknown) => this.createAutonomousRuntime().executeTool(toolName, toolInput, context);
    switch (name) {
      case 'system.status': return dispatch(name, {});
      case 'system.processes': return dispatch(name, {});
      case 'system.screenshot': return dispatch(name, { outputPath: input.outputPath || 'openarva-screenshot.png' });
      case 'system.exec': return dispatch(name, { command: String(input.command || ''), cwd: String(input.cwd || process.cwd()) });
      case 'workspace.search': return dispatch(name, { query: String(input.query || ''), cwd: String(input.cwd || process.cwd()) });
      case 'workspace.edit': return dispatch(name, { path: String(input.path || ''), content: String(input.content || ''), cwd: String(input.cwd || process.cwd()) });
      case 'workspace.exec': return dispatch(name, { command: String(input.command || ''), cwd: String(input.cwd || process.cwd()) });
      default: throw new Error(`Unknown native tool: ${String(name)}`);
    }
  }

  async respond(prompt: string, domain: AgentTask['domain'] = 'coding') {
    const recentContext = this.memory.getRecentContext(8);
    const retrieved = (await searchMemoryAsync(prompt, 5)).filter((item) => item.score > 0).map((item) => `[${item.source}] ${item.text}`).join('\n');
    const personalizedPrompt = [
      this.systemPersona.trim(),
      recentContext ? `[RECENT CONVERSATION]\n${recentContext}\n[/RECENT CONVERSATION]` : '',
      retrieved ? `[RETRIEVED LOCAL MEMORY]\n${retrieved}\n[/RETRIEVED LOCAL MEMORY]` : '',
      `[CURRENT TASK]\nDomain: ${domain}\nRequest: ${prompt}\n[/CURRENT TASK]`,
      'Respond directly with a practical answer. Do not claim that files or commands were changed unless a tool actually performed that action.',
    ].filter(Boolean).join('\n\n');

    this.memory.saveConversation('user', prompt);
    const route = OpenArvaRouter.resolveTaskRoute(capabilityForDomain(domain));
    const response = await routeAiCompletion(personalizedPrompt, route.provider, route.model);
    this.memory.saveConversation('assistant', response);
    await indexMemoryDocumentAsync({ id: `chat:${Date.now()}`, source: 'chat', text: `${prompt}\n${response}`, metadata: { domain } });
    return response;
  }

  private isSuspiciousCommand(cmd: string): boolean {
    const dangerousPatterns = [
      /rm\s+-rf\s+\//, // rm -rf /
      /format\s+[A-Z]:/i, // format C:
      /del\s+\/s\s+\/q/, // Windows delete all
    ];
    return dangerousPatterns.some(pattern => pattern.test(cmd));
  }
}