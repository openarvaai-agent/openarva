import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteMemoryDocuments, indexMemoryDocumentAsync, indexMemoryDocuments, indexTaskExecution, indexUserPreference, searchMemory, searchMemoryAsync, vectorStorePath } from './vectorStore.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.unstubAllGlobals();
});

describe('local vector memory', () => {
  it('indexes locally embedded documents and retrieves relevant context', () => {
    const suffix = Date.now().toString();
    indexMemoryDocuments([
      { id: `test:${suffix}:git`, source: 'github', text: `OpenArva repository release pipeline ${suffix}` },
      { id: `test:${suffix}:chat`, source: 'chat', text: `Unrelated cooking recipe ${suffix}` },
    ]);

    const matches = searchMemory(`repository release pipeline ${suffix}`, 2);
    expect(vectorStorePath()).toContain('vectors.sqlite');
    expect(matches[0]?.text).toContain('repository release pipeline');
    deleteMemoryDocuments([`test:${suffix}:git`, `test:${suffix}:chat`]);
  });

  it('indexes completed and failed task history locally and redacts sensitive values', async () => {
    const suffix = Date.now().toString();
    await indexTaskExecution({
      taskId: `memory-test-${suffix}`,
      goal: `Deploy the local release ${suffix} for owner@example.com`,
      plan: [{ tool: 'workspace.search', objective: 'find release configuration' }],
      errors: ['test failure'],
      retryCount: 1,
      planRevision: 2,
    }, 'failed');

    const matches = searchMemory(`release configuration ${suffix}`, 3, 'error');
    const match = matches.find((item) => item.id === `task:memory-test-${suffix}`);
    expect(match?.text).toContain('test failure');
    expect(match?.text).not.toContain('owner@example.com');
    deleteMemoryDocuments([`task:memory-test-${suffix}`]);
  });

  it('redacts credentials in persisted document metadata', () => {
    const id = `metadata-secret-${Date.now()}`;
    indexMemoryDocuments([{
      id,
      source: 'task',
      text: 'metadata redaction check',
      metadata: { config: { OPENAI_API_KEY: 'sk-metadata-test-secret' } },
    }]);
    const stored = searchMemory('metadata redaction check', 5, 'task').find((item) => item.id === id);
    expect(JSON.stringify(stored?.metadata)).not.toContain('sk-metadata-test-secret');
    deleteMemoryDocuments([id]);
  });

  it('indexes user preferences in the persistent memory store', async () => {
    const key = `tone-${Date.now()}`;
    await indexUserPreference(key, 'concise technical answers', 8);

    const matches = searchMemory(`concise technical answers ${key}`, 3, 'preference');

    expect(matches.some((item) => item.id === `preference:${key}`)).toBe(true);
    deleteMemoryDocuments([`preference:${key}`]);
  });

  it('uses an explicitly configured loopback Ollama embedding model for indexing and retrieval', async () => {
    const suffix = Date.now().toString();
    process.env.OPENARVA_EMBEDDING_MODEL = `nomic-embed-text-test-${suffix}`;
    process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:11434/v1';
    expect(() => searchMemory('pet dog')).toThrow('searchMemoryAsync');
    expect(() => indexMemoryDocuments([{ id: `sync:${suffix}`, source: 'task', text: 'must use real embeddings' }]))
      .toThrow('indexMemoryDocumentAsync');
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { input: string };
      const normalized = body.input.toLowerCase();
      const vector = normalized.includes('canine') ? [1, 0, 0]
        : normalized.includes('database') ? [0, 1, 0]
          : [0.99, 0.01, 0];
      return new Response(JSON.stringify({ embeddings: [vector] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await Promise.all([
      indexMemoryDocumentAsync({ id: `semantic:canine:${suffix}`, source: 'task', text: 'Canine companions benefit from daily walks.' }),
      indexMemoryDocumentAsync({ id: `semantic:database:${suffix}`, source: 'task', text: 'Database indexes optimize SQL query plans.' }),
    ]);

    const matches = await searchMemoryAsync(`pet dog ${suffix}`, 3, 'task');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('http://127.0.0.1:11434/api/embed');
    expect(matches[0]?.id).toBe(`semantic:canine:${suffix}`);
    expect(matches[0]?.score).toBeGreaterThan(matches[1]?.score || 0);
    deleteMemoryDocuments([`semantic:canine:${suffix}`, `semantic:database:${suffix}`]);
  });

  it('rejects configured remote embedding endpoints without sending a request', async () => {
    process.env.OPENARVA_EMBEDDING_MODEL = 'remote-model';
    process.env.OLLAMA_BASE_URL = 'https://models.example.com';
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    await expect(indexMemoryDocumentAsync({ id: 'remote-embedding-test', source: 'task', text: 'private task' }))
      .rejects.toThrow('loopback Ollama endpoint');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
