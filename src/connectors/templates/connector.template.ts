import type { z } from 'zod';
import type {
  ConnectorEventHandler,
  ConnectorProtocol,
  OutboundOpenArvaMessage,
  ProtocolConnector,
} from '../protocols/index.js';

export interface ConnectorTemplateHooks<Config> {
  start(onMessage: ConnectorEventHandler, config: Config): Promise<void>;
  stop(): Promise<void>;
  send(message: OutboundOpenArvaMessage, config: Config): Promise<void>;
}

export interface ConnectorTemplateDefinition<Config> {
  id: string;
  protocols: readonly ConnectorProtocol[];
  requiredEnv: readonly string[];
  configSchema: z.ZodType<Config>;
  readConfig(environment: NodeJS.ProcessEnv): unknown;
  hooks: ConnectorTemplateHooks<Config>;
}

export function defineConnector<Config>(definition: ConnectorTemplateDefinition<Config>): ProtocolConnector<Config> {
  return {
    id: definition.id,
    protocols: definition.protocols,
    readiness: 'implemented',
    requiredEnv: definition.requiredEnv,
    configSchema: definition.configSchema,
    readConfig: definition.readConfig,
    start: definition.hooks.start,
    stop: definition.hooks.stop,
    send: definition.hooks.send,
  };
}
