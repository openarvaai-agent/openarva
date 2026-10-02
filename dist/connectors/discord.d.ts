import { z } from 'zod';
import { type OpenArvaMessage, type ProtocolConnector } from './protocols/index.js';
declare const discordConfigSchema: z.ZodObject<{
    token: z.ZodString;
    allowedChannelIds: z.ZodArray<z.ZodString, "many">;
}, "strict", z.ZodTypeAny, {
    token: string;
    allowedChannelIds: string[];
}, {
    token: string;
    allowedChannelIds: string[];
}>;
type DiscordConfig = z.infer<typeof discordConfigSchema>;
interface DiscordAttachment {
    url?: unknown;
    content_type?: unknown;
    filename?: unknown;
    size?: unknown;
}
interface DiscordMessagePayload {
    id?: unknown;
    channel_id?: unknown;
    guild_id?: unknown;
    content?: unknown;
    timestamp?: unknown;
    author?: {
        id?: unknown;
        username?: unknown;
        bot?: unknown;
    };
    attachments?: DiscordAttachment[];
}
export declare function discordMessageToOpenArvaMessage(input: DiscordMessagePayload): OpenArvaMessage | undefined;
export declare class DiscordConnector implements ProtocolConnector<DiscordConfig> {
    readonly id = "discord";
    readonly protocols: readonly ["websocket", "rest"];
    readonly readiness: "implemented";
    readonly explicitOptIn = true;
    readonly requiredEnv: readonly ["DISCORD_BOT_TOKEN", "DISCORD_ALLOWED_CHANNEL_IDS"];
    readonly configSchema: z.ZodObject<{
        token: z.ZodString;
        allowedChannelIds: z.ZodArray<z.ZodString, "many">;
    }, "strict", z.ZodTypeAny, {
        token: string;
        allowedChannelIds: string[];
    }, {
        token: string;
        allowedChannelIds: string[];
    }>;
    private socket?;
    private heartbeat?;
    private reconnectTimer?;
    private config?;
    private onMessage?;
    private sequence;
    private heartbeatAcknowledged;
    private stopping;
    private reconnectAttempt;
    private readonly seenMessageIds;
    readConfig(environment: NodeJS.ProcessEnv): {
        token: string | undefined;
        allowedChannelIds: string[];
    };
    start(onMessage: (message: OpenArvaMessage) => Promise<void>, config: DiscordConfig): Promise<void>;
    stop(): Promise<void>;
    send(message: Parameters<ProtocolConnector<DiscordConfig>['send']>[0], config: DiscordConfig): Promise<void>;
    private connect;
    private handleGatewayPayload;
    private scheduleReconnect;
}
export {};
