# Contributing to OpenArva

Thank you for helping build OpenArva. Contributions are welcome across the CLI, agent engine, connectors, crawlers, native tools, memory layer, documentation, and desktop packaging.

## Before you start

- Read [SECURITY.md](SECURITY.md) for vulnerability reporting.
- Search existing issues before opening a new one.
- Never commit API keys, bot tokens, credentials, private keys, browser sessions, Telegram exports, or personal data.
- Keep changes focused and preserve existing public CLI behavior unless the change intentionally updates the interface.

## Local setup

Requirements:

- Node.js 20 or newer
- npm
- Git
- Optional: Ollama or another OpenAI-compatible local model endpoint
- Optional: Electron build prerequisites for desktop packages

```bash
git clone https://github.com/openarvaai-agent/openarva.git
cd openarva
npm install
npm run build
npm test
```

Useful development commands:

```bash
node dist/index.js --help
node dist/index.js doctor
node dist/index.js demo
npm run build
npm test
```

Native SQLite and Electron packages may run install scripts. Review npm's script approval prompts in your environment before enabling them.

## Code guidelines

- Use TypeScript and NodeNext ESM conventions.
- Keep imports using emitted `.js` extensions, for example `./module.js` from a `.ts` file.
- Prefer existing agent, gateway, state, sandbox, and provider abstractions.
- Keep local-first behavior explicit and avoid sending private data to external services without configuration and consent.
- Put risky commands behind the existing approval and sandbox paths.
- Add or update focused tests for new behavior.
- Keep generated `dist/` output out of source changes unless the release process specifically requires it.

## Adding a plugin

Third-party connectors and tools can use the contracts exported by `src/plugins/index.ts`:

```ts
import type { OpenArvaPlugin } from '@openarvaai/agent/dist/plugins/index.js';

const plugin: OpenArvaPlugin = {
  name: 'example-plugin',
  version: '1.0.0',
  tools: [{
    name: 'example.hello',
    description: 'Return a greeting.',
    execute: () => ({ message: 'hello' }),
  }],
};

export default plugin;
```

Connectors must implement the gateway connector contract and tools should validate input, avoid leaking secrets, and return structured results where practical.

### Adding an autonomous tool

Autonomous tools use a Zod schema and explicit permission classification. Register one on an `OpenArvaAgent` instance:

```ts
import { z } from 'zod';
import { OpenArvaAgent } from '@openarvaai/agent/dist/engine/agent.js';

const agent = new OpenArvaAgent();
agent.registerAutonomousTool({
  name: 'inventory.lookup',
  description: 'Read one inventory record by SKU.',
  permission: 'READ_ONLY',
  inputSchema: z.object({ sku: z.string().min(1) }).strict(),
  idempotent: true,
  timeoutMs: 5000,
  execute: async ({ sku }, { signal }) => inventoryApi.lookup(sku, { signal }),
});
```

The executor parses inputs before calling a tool and supplies an `AbortSignal` for timeouts. Only idempotent operations may be retried. Use `MODERATE` or `HIGH_RISK` for external side effects; autonomous approvals require an interactive human response and cannot be bypassed by `--yes` or `--force`. Never register destructive or financial behavior as `SAFE`.

## Pull requests

1. Create a focused branch.
2. Explain the user-visible behavior and implementation approach.
3. Include tests or a clear reason tests are not applicable.
4. Run `npm run build` and `npm test` locally.
5. Keep commits focused and use a clear conventional-style message.
6. Do not include generated credentials, local databases, session folders, or unrelated formatting changes.

## Issues

For bugs, include:

- OpenArva version and operating system
- Node.js version
- exact command or API request
- relevant sanitized logs
- minimal reproduction steps

For feature requests, describe the user problem, proposed workflow, privacy implications, and whether the feature should work offline.
