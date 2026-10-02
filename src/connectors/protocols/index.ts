import { z } from 'zod';
import { isIP } from 'node:net';
import { isPublicIpAddress } from '../../security/network.js';

function isSafeAttachmentUrl(value: string) {
  const parsed = new URL(value);
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return parsed.protocol === 'https:'
    && !parsed.username
    && !parsed.password
    && hostname !== 'localhost'
    && !hostname.endsWith('.localhost')
    && (isIP(hostname) === 0 || isPublicIpAddress(hostname));
}

const messagePartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().max(16_000) }).strict(),
  z.object({
    type: z.enum(['image', 'audio', 'video', 'file']),
    url: z.string().url().refine(isSafeAttachmentUrl, 'Attachment URLs must use public HTTPS and must not include credentials.').optional(),
    fileId: z.string().min(1).max(512).optional(),
    mimeType: z.string().max(255).optional(),
    fileName: z.string().max(255).optional(),
    sizeBytes: z.number().int().nonnegative().max(100 * 1024 * 1024).optional(),
  }).strict(),
]);

const metadataSchema = z.record(z.string().max(128), z.string().max(2048))
  .refine((metadata) => Object.keys(metadata).length <= 32, 'Message metadata is limited to 32 fields.');

export const openArvaMessageSchema = z.object({
  id: z.string().min(1).max(512),
  platform: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  conversationId: z.string().min(1).max(512),
  sender: z.object({ id: z.string().min(1).max(512), displayName: z.string().max(256).optional() }).strict(),
  timestamp: z.string().datetime(),
  content: z.object({
    text: z.string().max(16_000).optional(),
    parts: z.array(messagePartSchema).max(50).default([]),
  }).strict().refine((content) => Boolean(content.text) || content.parts.length > 0, 'A message must contain text or at least one content part.'),
  replyToMessageId: z.string().max(512).optional(),
  metadata: metadataSchema.optional(),
}).strict();

export const outboundMessageSchema = z.object({
  platform: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  conversationId: z.string().min(1).max(512),
  text: z.string().min(1).max(16_000),
  replyToMessageId: z.string().max(512).optional(),
  replyTo: openArvaMessageSchema.optional(),
}).strict();

export type OpenArvaMessage = z.infer<typeof openArvaMessageSchema>;
export type OutboundOpenArvaMessage = z.infer<typeof outboundMessageSchema>;
export type ConnectorProtocol = string;

export type ConnectorEventHandler = (message: OpenArvaMessage) => Promise<void>;

export interface ConnectorStatus {
  id: string;
  name: string;
  category: string;
  readiness: 'implemented' | 'partial' | 'placeholder' | 'interface';
  enabled: boolean;
  configured: boolean;
  protocols: string[];
  missingEnvironment: string[];
  notes?: string;
}

export interface ProtocolConnector<Config = unknown> {
  readonly id: string;
  readonly protocols: readonly ConnectorProtocol[];
  readonly readiness: 'implemented' | 'partial';
  readonly explicitOptIn?: boolean;
  readonly requiredEnv?: readonly string[];
  readonly configSchema?: z.ZodType<Config>;
  readConfig?(environment: NodeJS.ProcessEnv): unknown;
  start(onMessage: ConnectorEventHandler, config: Config): Promise<void>;
  stop(): Promise<void>;
  send(message: OutboundOpenArvaMessage, config: Config): Promise<void>;
}

export function toOpenArvaMessage(input: OpenArvaMessage): OpenArvaMessage {
  return openArvaMessageSchema.parse(input);
}
