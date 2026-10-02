import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FixedWindowRateLimiter } from '../security/rateLimit.js';
import { DiscordConnector } from './discord.js';
import type { GatewayConnector, InboundMessage, OutboundMessage } from './gateway.js';
import { getPlatformDescriptor, platformCatalog, type PlatformDescriptor } from './platformCatalog.js';
import {
  openArvaMessageSchema,
  outboundMessageSchema,
  type ConnectorEventHandler,
  type ConnectorStatus,
  type OpenArvaMessage,
  type OutboundOpenArvaMessage,
  type ProtocolConnector,
} from './protocols/index.js';

export interface ConnectorRegistryOptions {
  environment?: NodeJS.ProcessEnv;
  rateLimiter?: FixedWindowRateLimiter;
}

function enabledIds(environment: NodeJS.ProcessEnv) {
  const raw = environment.OPENARVA_CONNECTORS;
  return raw === undefined
    ? undefined
    : new Set(raw.split(',').map((id) => id.trim().toLowerCase()).filter(Boolean));
}

function loadPluginExport(moduleValue: unknown): ProtocolConnector | ProtocolConnector[] {
  if (!moduleValue || typeof moduleValue !== 'object') throw new Error('Connector module must export a connector object.');
  const exports = moduleValue as { default?: unknown; connector?: unknown; connectors?: unknown };
  const value = exports.connectors ?? exports.connector ?? exports.default;
  if (Array.isArray(value)) return value as ProtocolConnector[];
  if (!value || typeof value !== 'object') throw new Error('Connector module must export default, connector, or connectors.');
  return value as ProtocolConnector;
}

export class ConnectorRegistry {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly limiter: FixedWindowRateLimiter;
  private readonly connectors = new Map<string, ProtocolConnector>();
  private readonly running = new Set<string>();
  private readonly configs = new Map<string, unknown>();
  private readonly moduleConnectorIds = new Set<string>();
  private readonly loadedModules = new Set<string>();

  constructor(options: ConnectorRegistryOptions = {}) {
    this.environment = options.environment || process.env;
    this.limiter = options.rateLimiter || new FixedWindowRateLimiter(30, 60_000, 10_000);
    this.register(new DiscordConnector());
  }

  register(connector: ProtocolConnector) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(connector.id)) throw new Error(`Invalid connector ID: ${connector.id}`);
    if (this.connectors.has(connector.id)) throw new Error(`Connector already registered: ${connector.id}`);
    if (!connector.protocols.length) throw new Error(`Connector ${connector.id} must declare at least one protocol.`);
    if (!['implemented', 'partial'].includes(connector.readiness)) throw new Error(`Connector ${connector.id} has invalid readiness.`);
    if (typeof connector.start !== 'function' || typeof connector.stop !== 'function' || typeof connector.send !== 'function') {
      throw new Error(`Connector ${connector.id} must implement start, stop, and send.`);
    }
    this.connectors.set(connector.id, connector);
  }

  registerGatewayConnector(connector: GatewayConnector) {
    const adapter: ProtocolConnector = {
      id: connector.channel,
      protocols: [connector.channel === 'telegram' ? 'bot-api' : connector.channel === 'whatsapp' ? 'rest' : 'sip'],
      readiness: 'implemented',
      async start(onMessage) {
        await connector.start(async (incoming: InboundMessage) => onMessage(toGatewayMessage(incoming)));
      },
      stop: () => connector.stop(),
      async send(message) {
        await connector.send({
          channel: connector.channel,
          recipientId: message.conversationId,
          text: message.text,
          ...(message.replyTo ? { replyTo: toGatewayInbound(message.replyTo) } : {}),
        } as OutboundMessage);
      },
    };
    this.register(adapter);
  }

  async loadModules(modulePaths = this.environment.OPENARVA_CONNECTOR_MODULES || '') {
    for (const modulePath of modulePaths.split(',').map((item) => item.trim()).filter(Boolean)) {
      if (this.loadedModules.has(modulePath)) continue;
      const specifier = modulePath.startsWith('file:')
        ? modulePath
        : isAbsolute(modulePath) || modulePath.startsWith('.')
          ? pathToFileURL(resolve(modulePath)).href
          : modulePath;
      const moduleValue = await import(specifier) as unknown;
      const connectors = loadPluginExport(moduleValue);
      for (const connector of Array.isArray(connectors) ? connectors : [connectors]) {
        this.register(connector);
        this.moduleConnectorIds.add(connector.id);
      }
      this.loadedModules.add(modulePath);
    }
  }

  list(): ConnectorStatus[] {
    const explicitEnabled = enabledIds(this.environment);
    const descriptors = new Map(platformCatalog.map((platform) => [platform.id, platform]));
    for (const connector of this.connectors.values()) {
      if (!descriptors.has(connector.id)) {
        descriptors.set(connector.id, {
          id: connector.id,
          name: connector.id,
          category: 'enterprise-chat',
          protocols: [...connector.protocols],
          readiness: connector.readiness,
          requiredEnv: [...(connector.requiredEnv || [])],
        });
      }
    }
    return [...descriptors.values()].map((descriptor) => this.statusFor(descriptor, explicitEnabled));
  }

  get(id: string) {
    return this.connectors.get(id);
  }

  isRunning(id: string) {
    return this.running.has(id);
  }

  async startEnabled(onMessage: ConnectorEventHandler) {
    await this.loadModules();
    const requested = enabledIds(this.environment);
    const selected = requested || new Set([...this.connectors.values()]
      .filter((connector) => !this.moduleConnectorIds.has(connector.id) && !connector.explicitOptIn)
      .map((connector) => connector.id));
    for (const id of selected) {
      if (!this.connectors.has(id)) {
        const descriptor = getPlatformDescriptor(id);
        throw new Error(descriptor
          ? `Connector "${id}" is ${descriptor.readiness} and has no loaded implementation.`
          : `Connector "${id}" is not registered or found in the platform catalog.`);
      }
    }
    for (const id of selected) {
      const connector = this.connectors.get(id);
      if (!connector || this.running.has(id)) continue;
      const missing = (connector.requiredEnv || []).filter((key) => !this.environment[key]?.trim());
      if (missing.length) {
        if (requested) throw new Error(`Connector "${id}" requires environment variables: ${missing.join(', ')}.`);
        continue;
      }
      let config: unknown = undefined;
      if (connector.configSchema) {
        const raw = connector.readConfig?.(this.environment);
        config = connector.configSchema.parse(raw);
      }
      this.configs.set(id, config);
      await connector.start(async (message) => {
        const validated = openArvaMessageSchema.parse(message);
        if (validated.platform !== id) throw new Error(`Connector "${id}" emitted message for "${validated.platform}".`);
        const rateKey = `${id}:${validated.sender.id}`;
        if (!this.limiter.allow(rateKey)) throw new Error(`Inbound rate limit exceeded for connector "${id}".`);
        await onMessage(validated);
      }, config);
      this.running.add(id);
    }
  }

  async stopAll() {
    const errors: Error[] = [];
    for (const id of this.running) {
      try {
        await this.connectors.get(id)?.stop();
        this.running.delete(id);
        this.configs.delete(id);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (errors.length) throw new AggregateError(errors, 'One or more connectors failed to stop.');
  }

  async send(message: OutboundOpenArvaMessage) {
    const validated = outboundMessageSchema.parse(message);
    const connector = this.connectors.get(validated.platform);
    if (!connector) throw new Error(`Connector "${validated.platform}" has no loaded implementation.`);
    await connector.send(validated, this.configs.get(validated.platform));
  }

  private statusFor(descriptor: PlatformDescriptor, selected?: Set<string>): ConnectorStatus {
    const connector = this.connectors.get(descriptor.id);
    const requiredEnv = connector?.requiredEnv || descriptor.requiredEnv;
    const missingEnvironment = requiredEnv.filter((key) => !this.environment[key]?.trim());
    const explicitlySelected = selected ? selected.has(descriptor.id) : false;
    return {
      id: descriptor.id,
      name: descriptor.name,
      category: descriptor.category,
      readiness: connector?.readiness || descriptor.readiness,
      enabled: Boolean(connector && (selected ? explicitlySelected : this.running.has(descriptor.id))),
      configured: missingEnvironment.length === 0,
      protocols: connector ? [...connector.protocols] : descriptor.protocols,
      missingEnvironment,
      ...(descriptor.notes ? { notes: descriptor.notes } : {}),
    };
  }
}

function toGatewayMessage(message: InboundMessage): OpenArvaMessage {
  const text = message.text;
  return openArvaMessageSchema.parse({
    id: message.metadata?.messageSid || `${message.channel}:${message.senderId}:${message.receivedAt}`,
    platform: message.channel,
    conversationId: message.senderId,
    sender: { id: message.senderId },
    timestamp: message.receivedAt,
    content: { text, parts: [{ type: 'text', text }] },
    metadata: message.metadata,
  });
}

function toGatewayInbound(message: OpenArvaMessage): InboundMessage {
  return {
    channel: message.platform as InboundMessage['channel'],
    senderId: message.sender.id,
    text: message.content.text || message.content.parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n'),
    receivedAt: message.timestamp,
    metadata: message.metadata,
  };
}

export function createPlatformCatalog() {
  return platformCatalog.map((descriptor) => ({ ...descriptor }));
}
