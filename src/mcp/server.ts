// The SDK is provided by the application's runtime dependency graph.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

export class OpenArvaMCPServer {
  readonly integrationStatus = 'placeholder' as const;
  readonly registeredToolCount = 0;
  private server: Server;

  constructor() {
    this.server = new Server(
      { name: 'openarva-mcp-server', version: '17.6.21' },
      { capabilities: { tools: {} } }
    );
  }

  async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.warn('[OpenArva MCP] Stdio transport active; no tools are registered, so the integration is not yet useful to clients.');
  }
}