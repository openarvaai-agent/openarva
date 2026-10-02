import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import chalk from 'chalk';
import { parseSafeCommand, runSandboxedCommandDetailed } from '../engine/sandbox.js';
import { runToolWithSafetyPolicy, isPolicyExecutionContext, type PolicyExecutionContext } from './executionPolicy.js';
import { z } from 'zod';

function assertWorkspacePath(filePath: string, cwd = process.cwd()) {
  const root = resolve(cwd);
  const target = resolve(root, filePath);
  if (target !== root && !target.startsWith(`${root}${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error('Workspace path must remain inside the current project.');
  return target;
}

export function searchWorkspace(query: string, cwd = process.cwd()) {
  const pattern = new RegExp(query, 'i');
  const results: string[] = [];
  const ignored = new Set(['node_modules', '.git', 'dist']);
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) { try { const content = readFileSync(path, 'utf8'); if (pattern.test(content)) results.push(path); } catch { /* binary/unreadable file */ } }
    }
  };
  walk(resolve(cwd));
  return results;
}

async function editWorkspaceFileRaw(filePath: string, content: string, cwd: string) {
  const target = assertWorkspacePath(filePath, cwd);
  const before = existsSync(target) ? readFileSync(target, 'utf8') : '';
  console.log(chalk.cyan.bold('Diff Preview'));
  if (before) console.log(chalk.red(before.split(/\r?\n/).map((line) => `- ${line}`).join('\n')));
  if (content) console.log(chalk.green(content.split(/\r?\n/).map((line) => `+ ${line}`).join('\n')));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
  return true;
}

const workspaceEditInput = z.object({ path: z.string().min(1), content: z.string(), cwd: z.string().optional() }).strict();
const workspaceCommandInput = z.object({ command: z.string().min(1), cwd: z.string().optional() }).strict();

export async function editWorkspaceFile(filePath: string, content: string, cwd = process.cwd(), context?: PolicyExecutionContext) {
  if (isPolicyExecutionContext(context)) return editWorkspaceFileRaw(filePath, content, cwd);
  return runToolWithSafetyPolicy({
    name: 'workspace.edit', permission: 'MODERATE', inputSchema: workspaceEditInput,
    execute: (input) => editWorkspaceFileRaw(input.path, input.content, input.cwd || process.cwd()),
  }, { path: filePath, content, cwd }, { taskId: randomUUID(), operationId: randomUUID(), idempotent: false });
}

async function executeWorkspaceCommandRaw(input: string, cwd: string, signal?: AbortSignal) {
  const parsed = parseSafeCommand(input);
  const result = await runSandboxedCommandDetailed(parsed.command, parsed.args, resolve(cwd), 120_000, undefined, signal);
  return result;
}

export async function executeWorkspaceCommand(input: string, cwd = process.cwd(), context?: PolicyExecutionContext | AbortSignal) {
  const trustedContext = isPolicyExecutionContext(context) ? context : undefined;
  if (trustedContext) return executeWorkspaceCommandRaw(input, cwd, trustedContext.signal);
  const externalSignal = context instanceof AbortSignal ? context : undefined;
  return runToolWithSafetyPolicy({
    name: 'workspace.exec', permission: 'HIGH_RISK', inputSchema: workspaceCommandInput,
    execute: (toolInput, toolContext) => executeWorkspaceCommandRaw(toolInput.command, toolInput.cwd || process.cwd(), toolContext.signal),
  }, { command: input, cwd }, { taskId: randomUUID(), operationId: randomUUID(), idempotent: false, signal: externalSignal });
}
