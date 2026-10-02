import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { sanitizeSensitiveData } from '../security/sanitizer.js';

export interface MemoryDocument {
  id: string;
  source: 'chat' | 'github' | 'codebase' | 'telegram' | string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface MemoryMatch extends MemoryDocument {
  score: number;
}

const dimensions = 128;
const databaseDirectory = join(homedir(), '.openarva', 'memory');
const databasePath = join(databaseDirectory, 'vectors.sqlite');
let database: Database | undefined;

function getDatabase() {
  if (database) return database;
  mkdirSync(databaseDirectory, { recursive: true });
  database = new Database(databasePath);
  database.exec('CREATE TABLE IF NOT EXISTS vector_memories (id TEXT PRIMARY KEY, source TEXT NOT NULL, text TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT \'{}\', embedding TEXT NOT NULL, embedding_model TEXT NOT NULL DEFAULT \'local-hash-v1\', indexed_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS idx_vector_memories_source ON vector_memories(source);');
  const columns = database.prepare('PRAGMA table_info(vector_memories)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'embedding_model')) {
    database.exec("ALTER TABLE vector_memories ADD COLUMN embedding_model TEXT NOT NULL DEFAULT 'local-hash-v1'");
  }
  return database;
}

function tokens(text: string) { return text.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) || []; }

function normalizeVector(vector: number[]) {
  if (!vector.length || vector.length > 32_768 || vector.some((value) => !Number.isFinite(value))) {
    throw new Error('Embedding provider returned an invalid or unsupported vector.');
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!norm) throw new Error('Embedding provider returned a zero-length vector.');
  return vector.map((value) => value / norm);
}

function sanitizeMetadata(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeSensitiveData(value).text;
  if (Array.isArray(value)) return value.map(sanitizeMetadata);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      sanitizeSensitiveData(key).text,
      /(?:api[_ -]?key|bot[_ -]?token|auth[_ -]?token|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|secret)/i.test(key)
        ? '[REDACTED_SECRET]'
        : sanitizeMetadata(item),
    ]));
  }
  return value;
}

export function embedLocally(text: string) {
  const vector = Array<number>(dimensions).fill(0);
  for (const token of tokens(text)) {
    const digest = createHash('sha256').update(token).digest();
    for (let offset = 0; offset < 4; offset += 1) {
      const index = digest.readUInt32BE(offset * 4) % dimensions;
      vector[index] += digest[offset] % 2 === 0 ? 1 : -1;
    }
  }
  if (vector.every((value) => value === 0)) return vector;
  return normalizeVector(vector);
}

function similarity(left: number[], right: number[]) { return left.reduce((sum, value, index) => sum + value * (right[index] || 0), 0); }

function embeddingConfig() {
  const model = process.env.OPENARVA_EMBEDDING_MODEL || process.env.OLLAMA_EMBEDDING_MODEL;
  if (!model) return undefined;
  const baseUrl = process.env.OLLAMA_BASE_URL || process.env.LOCAL_AI_BASE_URL || 'http://localhost:11434';
  const url = new URL(baseUrl);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const loopback = hostname === 'localhost' || (isIP(hostname) === 4 && hostname.startsWith('127.')) || hostname === '::1';
  if (!['http:', 'https:'].includes(url.protocol) || !loopback || url.username || url.password) {
    throw new Error('Memory embeddings require a credential-free loopback Ollama endpoint.');
  }
  url.pathname = `${url.pathname.replace(/\/v1\/?$/, '').replace(/\/+$/, '')}/api/embed`;
  url.search = '';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(model)) throw new Error('Embedding model name is invalid.');
  return { model, url: url.toString() };
}

async function embedForIndex(text: string) {
  const config = embeddingConfig();
  if (!config) return { vector: embedLocally(text), model: 'local-hash-v1' };
  const response = await fetch(config.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.model, input: text }),
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`Local embedding request failed with HTTP ${response.status}.`);
  const result = await response.json() as { embeddings?: unknown };
  const vector = Array.isArray(result.embeddings) ? result.embeddings[0] : undefined;
  if (!Array.isArray(vector) || !vector.length || vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error('Local embedding provider returned an invalid vector.');
  }
  return { vector: normalizeVector(vector as number[]), model: `ollama:${config.model}` };
}

function writeDocument(document: MemoryDocument, vector: number[], model: string) {
  if (!vector.length || vector.length > 32_768 || vector.some((value) => !Number.isFinite(value))) {
    throw new Error('Memory embedding is invalid or exceeds the supported dimension limit.');
  }
  const safeText = sanitizeSensitiveData(document.text).text;
  const statement = getDatabase().prepare('INSERT OR REPLACE INTO vector_memories (id, source, text, metadata, embedding, embedding_model, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  statement.run(document.id, document.source, safeText, JSON.stringify(sanitizeMetadata(document.metadata || {})), JSON.stringify(vector), model, new Date().toISOString());
}

export function indexMemoryDocument(document: MemoryDocument) {
  if (embeddingConfig()) throw new Error('Configured semantic embeddings require indexMemoryDocumentAsync().');
  const safeDocument = { ...document, text: sanitizeSensitiveData(document.text).text };
  writeDocument(safeDocument, embedLocally(safeDocument.text), 'local-hash-v1');
}

export async function indexMemoryDocumentAsync(document: MemoryDocument) {
  const safeDocument = { ...document, text: sanitizeSensitiveData(document.text).text };
  const { vector, model } = await embedForIndex(safeDocument.text);
  writeDocument(safeDocument, vector, model);
}

export function indexMemoryDocuments(documents: MemoryDocument[]) {
  for (const document of documents) indexMemoryDocument(document);
  return documents.length;
}

export async function indexMemoryDocumentsAsync(documents: MemoryDocument[]) {
  for (const document of documents) await indexMemoryDocumentAsync(document);
  return documents.length;
}

interface StoredMemory { id: string; source: string; text: string; metadata: string; embedding: string; embedding_model: string; }
function hydrateMatch(row: StoredMemory, queryVector: number[]): MemoryMatch {
  let metadata: Record<string, unknown> = {};
  let embedding: number[] = [];
  try { metadata = JSON.parse(row.metadata) as Record<string, unknown>; embedding = JSON.parse(row.embedding) as number[]; } catch { /* malformed historical rows are not searchable */ }
  const score = embedding.length === queryVector.length && embedding.every(Number.isFinite)
    ? similarity(queryVector, embedding)
    : 0;
  return { id: row.id, source: row.source, text: row.text, metadata, score };
}

function searchLocalMemory(query: string, limit = 5, source?: string): MemoryMatch[] {
  const rows = source
    ? getDatabase().prepare('SELECT id, source, text, metadata, embedding, embedding_model FROM vector_memories WHERE source = ? AND embedding_model = ?').all<StoredMemory>(source, 'local-hash-v1')
    : getDatabase().prepare('SELECT id, source, text, metadata, embedding, embedding_model FROM vector_memories WHERE embedding_model = ?').all<StoredMemory>('local-hash-v1');
  const queryVector = embedLocally(query);
  return rows.map((row) => hydrateMatch(row, queryVector)).sort((left, right) => right.score - left.score).slice(0, Math.max(1, limit));
}

export function searchMemory(query: string, limit = 5, source?: string): MemoryMatch[] {
  if (embeddingConfig()) throw new Error('Configured semantic embeddings require searchMemoryAsync().');
  return searchLocalMemory(query, limit, source);
}

export async function searchMemoryAsync(query: string, limit = 5, source?: string): Promise<MemoryMatch[]> {
  const config = embeddingConfig();
  if (!config) return searchLocalMemory(query, limit, source);
  const { vector } = await embedForIndex(query);
  const models = [process.env.OPENARVA_EMBEDDING_MODEL || process.env.OLLAMA_EMBEDDING_MODEL, `ollama:${process.env.OPENARVA_EMBEDDING_MODEL || process.env.OLLAMA_EMBEDDING_MODEL}`]
    .filter((model): model is string => Boolean(model));
  if (!models.length) return searchLocalMemory(query, limit, source);
  const placeholders = models.map(() => '?').join(', ');
  const rows = source
    ? getDatabase().prepare(`SELECT id, source, text, metadata, embedding, embedding_model FROM vector_memories WHERE source = ? AND embedding_model IN (${placeholders})`).all<StoredMemory>(source, ...models)
    : getDatabase().prepare(`SELECT id, source, text, metadata, embedding, embedding_model FROM vector_memories WHERE embedding_model IN (${placeholders})`).all<StoredMemory>(...models);
  const semanticMatches = rows.map((row) => hydrateMatch(row, vector));
  const semanticIds = new Set(semanticMatches.map((match) => match.id));
  const lexicalMatches = searchLocalMemory(query, limit, source)
    .filter((match) => !semanticIds.has(match.id))
    .map((match) => ({ ...match, score: Math.max(0, match.score) * 0.25 }));
  return [...semanticMatches, ...lexicalMatches]
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(1, limit));
}

export function hasMemoryDocument(id: string) {
  return Boolean(getDatabase().prepare('SELECT 1 FROM vector_memories WHERE id = ?').get(id));
}

export function deleteMemoryDocuments(ids: string[]) {
  if (!ids.length) return 0;
  const placeholders = ids.map(() => '?').join(', ');
  return getDatabase().prepare(`DELETE FROM vector_memories WHERE id IN (${placeholders})`).run(...ids).changes;
}

export async function indexUserPreference(key: string, value: unknown, importance = 5) {
  let serialized: string;
  try { serialized = typeof value === 'string' ? value : JSON.stringify(value); }
  catch { serialized = String(value); }
  await indexMemoryDocumentAsync({
    id: `preference:${key}`,
    source: 'preference',
    text: `User preference ${key}: ${serialized}`,
    metadata: { importance },
  });
}

export function memoryEmbeddingMode() {
  return embeddingConfig() ? 'ollama-local' : 'local-feature-hash';
}

export async function indexTaskExecution(task: {
  taskId: string;
  goal: string;
  plan: Array<{ tool: string; objective: string }>;
  errors: string[];
  retryCount: number;
  planRevision: number;
}, outcome: 'completed' | 'failed') {
  const details = [
    `Task outcome: ${outcome}`,
    `Goal: ${task.goal}`,
    `Tools: ${task.plan.map((step) => `${step.tool} (${step.objective})`).join('; ') || 'none'}`,
    task.errors.length ? `Errors: ${task.errors.join('; ')}` : '',
    `Retries: ${task.retryCount}; plan revisions: ${task.planRevision}`,
  ].filter(Boolean).join('\n');
  await indexMemoryDocumentAsync({
    id: `task:${task.taskId}`,
    source: outcome === 'failed' ? 'error' : 'task',
    text: details,
    metadata: { taskId: task.taskId, outcome, retryCount: task.retryCount, planRevision: task.planRevision },
  });
}

export function vectorStorePath() { return databasePath; }
