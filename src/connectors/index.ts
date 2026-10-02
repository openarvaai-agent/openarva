export { ConnectorRegistry, createPlatformCatalog } from './registry.js';
export { platformCatalog, getPlatformDescriptor } from './platformCatalog.js';
export type { ConnectorCategory, ConnectorReadiness, PlatformDescriptor } from './platformCatalog.js';
export { openArvaMessageSchema, outboundMessageSchema } from './protocols/index.js';
export type {
  ConnectorEventHandler,
  ConnectorProtocol,
  ConnectorStatus,
  OpenArvaMessage,
  OutboundOpenArvaMessage,
  ProtocolConnector,
} from './protocols/index.js';
export { defineConnector } from './templates/connector.template.js';
export type { ConnectorTemplateDefinition, ConnectorTemplateHooks } from './templates/connector.template.js';
export { DiscordConnector, discordMessageToOpenArvaMessage } from './discord.js';
