import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { OpenArvaAgent } from '../engine/agent.js';
import { WhatsAppConnector } from './whatsapp.js';
import { TelegramConnector } from './telegram.js';
import { FixedWindowRateLimiter } from '../security/rateLimit.js';
import { verifyTwilioWebhook } from '../security/twilioWebhook.js';
import { SqliteReplayGuard, type ReplayGuard } from '../security/webhookSecurity.js';
import { ConnectorRegistry } from './registry.js';

export type GatewayChannel = 'telegram' | 'whatsapp' | 'sip';

export interface InboundMessage {
  channel: GatewayChannel;
  senderId: string;
  text: string;
  receivedAt: string;
  metadata?: Record<string, string>;
}

export interface OutboundMessage {
  channel: GatewayChannel;
  recipientId: string;
  text: string;
  replyTo?: InboundMessage;
}

export interface GatewayConnector {
  readonly channel: GatewayChannel;
  start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  send(message: OutboundMessage): Promise<void>;
  parseWebhook?(body: string, contentType?: string): InboundMessage | null;
}

export interface GatewayOptions {
  port?: number;
  host?: string;
  agent?: Pick<OpenArvaAgent, 'respond'>;
  connectors?: GatewayConnector[];
  replayGuard?: ReplayGuard;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function normalizeWhatsAppSender(sender: string) {
  return sender.trim().replace(/^whatsapp:/i, '');
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > 64 * 1024) {
        reject(new Error('Request body is too large.'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

export class MultiChannelGateway {
  private readonly connectors = new Map<GatewayChannel, GatewayConnector>();
  private readonly connectorRegistry: ConnectorRegistry;
  private readonly agent: Pick<OpenArvaAgent, 'respond'>;
  private readonly port: number;
  private readonly host: string;
  private readonly inboundLimiter = new FixedWindowRateLimiter(30, 60_000, 10_000);
  private replayGuard?: ReplayGuard;
  private server: ReturnType<typeof createServer> | null = null;

  constructor(options: GatewayOptions = {}) {
    this.agent = options.agent || new OpenArvaAgent();
    this.port = options.port ?? Number(process.env.OPENARVA_GATEWAY_PORT || 18789);
    this.host = options.host || process.env.OPENARVA_GATEWAY_HOST || '127.0.0.1';
    this.replayGuard = options.replayGuard;
    this.connectorRegistry = new ConnectorRegistry();
    for (const connector of options.connectors || [new TelegramConnector(), new WhatsAppConnector()]) {
      this.connectors.set(connector.channel, connector);
      this.connectorRegistry.registerGatewayConnector(connector);
    }
  }

  async route(message: InboundMessage) {
    const text = message.text.trim();
    if (!text) return;
    const response = await this.agent.respond(text, 'coding');
    await this.send({ channel: message.channel, recipientId: message.senderId, text: response, replyTo: message });
  }

  async send(message: OutboundMessage) {
    await this.connectorRegistry.send({
      platform: message.channel,
      conversationId: message.recipientId,
      text: message.text,
      ...(message.replyTo ? { replyTo: {
        id: message.replyTo.metadata?.messageSid || `${message.replyTo.channel}:${message.replyTo.senderId}:${message.replyTo.receivedAt}`,
        platform: message.replyTo.channel,
        conversationId: message.replyTo.senderId,
        sender: { id: message.replyTo.senderId },
        timestamp: message.replyTo.receivedAt,
        content: { text: message.replyTo.text, parts: [{ type: 'text', text: message.replyTo.text }] },
        metadata: message.replyTo.metadata,
      } } : {}),
    });
  }

  async start() {
    if (this.server) return;
    const isLoopbackHost = this.host === '127.0.0.1' || this.host === '::1' || this.host === 'localhost';
    if (!isLoopbackHost && !process.env.OPENARVA_AUTH_KEY) throw new Error('OPENARVA_AUTH_KEY is required before binding the gateway to a non-loopback host.');
    this.server = createServer((req, res) => this.handleHttp(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(this.port, this.host, () => resolve());
    });

    try {
      await this.connectorRegistry.startEnabled((message) => this.route({
        channel: message.platform as GatewayChannel,
        senderId: message.sender.id,
        text: message.content.text || message.content.parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n'),
        receivedAt: message.timestamp,
        metadata: message.metadata,
      }));
    } catch (error) {
      await this.stop();
      throw error;
    }

    console.log(`OpenArva multi-channel gateway listening on http://${this.host}:${this.port}`);
    console.log(`Channels: ${this.connectorRegistry.list().filter((status) => status.enabled).map((status) => status.id).join(', ') || 'none configured'}`);
  }

  getBoundPort() {
    const address = this.server?.address();
    if (!address || typeof address === 'string') throw new Error('Gateway server is not listening on a TCP port.');
    return address.port;
  }

  async stop() {
    await this.connectorRegistry.stopAll();
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    this.server = null;
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url || '/', `http://${req.headers.host || `${this.host}:${this.port}`}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true, service: 'openarva-gateway', channels: Array.from(this.connectors.keys()) });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/webhooks/whatsapp') {
      if (!this.inboundLimiter.allow(req.socket.remoteAddress || '')) {
        sendJson(res, 429, { ok: false, error: 'Rate limit exceeded.' });
        return;
      }
      const connector = this.connectors.get('whatsapp');
      if (!connector || !this.connectorRegistry.isRunning('whatsapp') || typeof connector.parseWebhook !== 'function') {
        sendJson(res, 404, { ok: false, error: 'WhatsApp connector is disabled.' });
        return;
      }
      try {
        const body = await readBody(req);
        const contentType = req.headers['content-type'] || '';
        if (!contentType.toLowerCase().includes('application/x-www-form-urlencoded')) {
          sendJson(res, 415, { ok: false, error: 'Twilio form-encoded webhooks are required.' });
          return;
        }
        const params = Object.fromEntries(new URLSearchParams(body).entries());
        const configuredUrl = process.env.TWILIO_WHATSAPP_WEBHOOK_URL;
        const signatureHeader = req.headers['x-twilio-signature'];
        const signature = typeof signatureHeader === 'string' ? signatureHeader : undefined;
        if (!verifyTwilioWebhook(process.env.TWILIO_AUTH_TOKEN, signature, configuredUrl, params)) {
          sendJson(res, configuredUrl ? 401 : 503, { ok: false, error: configuredUrl ? 'Invalid Twilio signature.' : 'TWILIO_WHATSAPP_WEBHOOK_URL is not configured.' });
          return;
        }
        const messageSid = params.MessageSid;
        if (!messageSid) {
          sendJson(res, 400, { ok: false, error: 'Twilio MessageSid is required for replay protection.' });
          return;
        }
        this.replayGuard ||= new SqliteReplayGuard();
        const replayNow = Date.now();
        if (!this.replayGuard.consume(`twilio:${messageSid}`, replayNow + 24 * 60 * 60_000, replayNow)) {
          sendJson(res, 409, { ok: false, error: 'Duplicate Twilio MessageSid.' });
          return;
        }
        const message = connector.parseWebhook(body, contentType);
        if (message) {
          const allowedSenders = new Set((process.env.WHATSAPP_ALLOWED_SENDERS || '')
            .split(',')
            .map(normalizeWhatsAppSender)
            .filter(Boolean));
          if (!allowedSenders.size) {
            sendJson(res, 503, { ok: false, error: 'WHATSAPP_ALLOWED_SENDERS is required to enable inbound WhatsApp messages.' });
            return;
          }
          if (!allowedSenders.has(normalizeWhatsAppSender(message.senderId))) {
            sendJson(res, 403, { ok: false, error: 'WhatsApp sender is not authorized.' });
            return;
          }
          await this.route(message);
        }
        sendJson(res, 200, { ok: true, accepted: Boolean(message) });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    sendJson(res, 404, { ok: false, error: 'Not found' });
  }
}

export async function runMultiChannelGateway(options: GatewayOptions = {}) {
  const gateway = new MultiChannelGateway(options);
  await gateway.start();
  const stop = () => { void gateway.stop(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return gateway;
}

export function startMultiChannelGatewayDetached() {
  const entry = fileURLToPath(new URL('../index.js', import.meta.url));
  const child: ChildProcess = spawn(process.execPath, [entry, 'gateway', 'daemon'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}
