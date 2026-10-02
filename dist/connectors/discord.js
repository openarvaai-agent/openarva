import { z } from 'zod';
import WebSocket from 'ws';
import { fetchPublicHttp } from '../security/network.js';
import { openArvaMessageSchema, outboundMessageSchema } from './protocols/index.js';
const discordConfigSchema = z.object({
    token: z.string().min(1),
    allowedChannelIds: z.array(z.string().min(1).max(100)).min(1),
}).strict();
function decodeGatewayData(data) {
    if (typeof data === 'string')
        return data;
    if (Buffer.isBuffer(data))
        return data.toString('utf8');
    if (Array.isArray(data))
        return Buffer.concat(data).toString('utf8');
    return Buffer.from(data).toString('utf8');
}
export function discordMessageToOpenArvaMessage(input) {
    if (typeof input.id !== 'string' || typeof input.channel_id !== 'string'
        || typeof input.author?.id !== 'string' || input.author.bot === true)
        return undefined;
    const parts = [];
    for (const attachment of input.attachments || []) {
        if (typeof attachment.url !== 'string')
            continue;
        const mimeType = typeof attachment.content_type === 'string' ? attachment.content_type : undefined;
        const type = mimeType?.startsWith('image/') ? 'image'
            : mimeType?.startsWith('audio/') ? 'audio'
                : mimeType?.startsWith('video/') ? 'video' : 'file';
        parts.push({
            type,
            url: attachment.url,
            ...(mimeType ? { mimeType } : {}),
            ...(typeof attachment.filename === 'string' ? { fileName: attachment.filename.slice(0, 255) } : {}),
            ...(typeof attachment.size === 'number' && Number.isSafeInteger(attachment.size) && attachment.size >= 0
                ? { sizeBytes: Math.min(attachment.size, 100 * 1024 * 1024) } : {}),
        });
    }
    const text = typeof input.content === 'string' ? input.content.slice(0, 16_000) : '';
    if (text)
        parts.unshift({ type: 'text', text });
    if (!text && !parts.length)
        return undefined;
    const message = openArvaMessageSchema.parse({
        id: input.id,
        platform: 'discord',
        conversationId: input.channel_id,
        sender: {
            id: input.author.id,
            ...(typeof input.author.username === 'string' ? { displayName: input.author.username.slice(0, 256) } : {}),
        },
        timestamp: typeof input.timestamp === 'string' ? input.timestamp : new Date().toISOString(),
        content: { ...(text ? { text } : {}), parts },
        ...(typeof input.guild_id === 'string' ? { metadata: { guildId: input.guild_id } } : {}),
    });
    return message;
}
export class DiscordConnector {
    id = 'discord';
    protocols = ['websocket', 'rest'];
    readiness = 'implemented';
    explicitOptIn = true;
    requiredEnv = ['DISCORD_BOT_TOKEN', 'DISCORD_ALLOWED_CHANNEL_IDS'];
    configSchema = discordConfigSchema;
    socket;
    heartbeat;
    reconnectTimer;
    config;
    onMessage;
    sequence = null;
    heartbeatAcknowledged = true;
    stopping = false;
    reconnectAttempt = 0;
    seenMessageIds = new Set();
    readConfig(environment) {
        return {
            token: environment.DISCORD_BOT_TOKEN,
            allowedChannelIds: (environment.DISCORD_ALLOWED_CHANNEL_IDS || '').split(',').map((id) => id.trim()).filter(Boolean),
        };
    }
    async start(onMessage, config) {
        this.config = this.configSchema.parse(config);
        this.onMessage = onMessage;
        this.stopping = false;
        await this.connect();
    }
    async stop() {
        this.stopping = true;
        this.onMessage = undefined;
        this.config = undefined;
        if (this.heartbeat)
            clearInterval(this.heartbeat);
        if (this.reconnectTimer)
            clearTimeout(this.reconnectTimer);
        this.heartbeat = undefined;
        this.reconnectTimer = undefined;
        this.seenMessageIds.clear();
        const socket = this.socket;
        this.socket = undefined;
        socket?.close(1000, 'OpenArva connector stopped');
    }
    async send(message, config) {
        const validated = outboundMessageSchema.parse(message);
        if (validated.platform !== this.id)
            throw new Error('Discord connector only accepts discord platform messages.');
        const credentials = this.configSchema.parse(config);
        if (!credentials.allowedChannelIds.includes(validated.conversationId)) {
            throw new Error('Discord outbound channel is not in DISCORD_ALLOWED_CHANNEL_IDS.');
        }
        if (validated.text.length > 2_000)
            throw new Error('Discord messages are limited to 2000 characters.');
        const replyId = validated.replyToMessageId || validated.replyTo?.id;
        const payload = {
            content: validated.text,
            ...(replyId ? { message_reference: { message_id: replyId, fail_if_not_exists: false } } : {}),
            allowed_mentions: { parse: [] },
        };
        const response = await fetchPublicHttp(`https://discord.com/api/v10/channels/${encodeURIComponent(validated.conversationId)}/messages`, {
            method: 'POST',
            headers: {
                Authorization: `Bot ${credentials.token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(15_000),
            allowJson: true,
            maxBytes: 1_000_000,
            maxRedirects: 0,
        });
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`Discord send failed with HTTP ${response.status}. Check bot permissions and channel access.`);
        }
    }
    async connect() {
        if (this.stopping || !this.config)
            return;
        const response = await fetchPublicHttp('https://discord.com/api/v10/gateway/bot', {
            method: 'GET',
            headers: { Authorization: `Bot ${this.config.token}` },
            signal: AbortSignal.timeout(15_000),
            allowJson: true,
            maxBytes: 64_000,
            maxRedirects: 0,
        });
        if (response.status < 200 || response.status >= 300)
            throw new Error(`Discord gateway discovery failed with HTTP ${response.status}.`);
        const gatewayResponse = z.object({ url: z.string().url() }).parse(JSON.parse(response.body.toString('utf8')));
        const gatewayUrl = new URL(gatewayResponse.url);
        if (gatewayUrl.protocol !== 'wss:' || gatewayUrl.hostname !== 'gateway.discord.gg' || gatewayUrl.username || gatewayUrl.password) {
            throw new Error('Discord returned an invalid Gateway URL.');
        }
        gatewayUrl.searchParams.set('v', '10');
        gatewayUrl.searchParams.set('encoding', 'json');
        const socket = new WebSocket(gatewayUrl);
        this.socket = socket;
        socket.on('message', (data) => {
            void this.handleGatewayPayload(socket, decodeGatewayData(data)).catch(() => {
                console.warn('[OpenArva Discord] A gateway event was rejected.');
            });
        });
        socket.on('close', () => {
            if (this.socket === socket)
                this.socket = undefined;
            if (this.heartbeat)
                clearInterval(this.heartbeat);
            this.heartbeat = undefined;
            this.scheduleReconnect();
        });
        socket.on('error', () => {
            console.warn('[OpenArva Discord] Gateway connection error.');
        });
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                socket.close();
                reject(new Error('Discord Gateway connection timed out.'));
            }, 15_000);
            const opened = () => {
                clearTimeout(timer);
                socket.off('error', failed);
                resolve();
            };
            const failed = () => {
                clearTimeout(timer);
                socket.off('open', opened);
                reject(new Error('Discord Gateway connection failed.'));
            };
            socket.once('open', opened);
            socket.once('error', failed);
        });
        this.reconnectAttempt = 0;
    }
    async handleGatewayPayload(socket, raw) {
        const payload = z.object({ op: z.number().int(), s: z.number().int().nullable().optional(), t: z.string().nullable().optional(), d: z.unknown().optional() })
            .passthrough().parse(JSON.parse(raw));
        if (typeof payload.s === 'number')
            this.sequence = payload.s;
        if (payload.op === 10) {
            const hello = z.object({ heartbeat_interval: z.number().int().positive() }).parse(payload.d);
            this.heartbeatAcknowledged = true;
            if (this.heartbeat)
                clearInterval(this.heartbeat);
            this.heartbeat = setInterval(() => {
                if (!this.heartbeatAcknowledged) {
                    socket.close(4000, 'Heartbeat acknowledgement missed');
                    return;
                }
                this.heartbeatAcknowledged = false;
                socket.send(JSON.stringify({ op: 1, d: this.sequence }));
            }, hello.heartbeat_interval);
            this.heartbeat.unref();
            socket.send(JSON.stringify({
                op: 2,
                d: {
                    token: this.config?.token,
                    intents: 1 | 512 | 4096 | 32768,
                    properties: { os: process.platform, browser: 'OpenArva', device: 'OpenArva' },
                },
            }));
            return;
        }
        if (payload.op === 1) {
            socket.send(JSON.stringify({ op: 1, d: this.sequence }));
            return;
        }
        if (payload.op === 11) {
            this.heartbeatAcknowledged = true;
            return;
        }
        if (payload.op === 7 || payload.op === 9) {
            socket.close(4000, 'Discord requested reconnect');
            return;
        }
        if (payload.op !== 0 || payload.t !== 'MESSAGE_CREATE')
            return;
        const message = discordMessageToOpenArvaMessage(payload.d);
        if (!message || !this.config?.allowedChannelIds.includes(message.conversationId)
            || this.seenMessageIds.has(message.id))
            return;
        this.seenMessageIds.add(message.id);
        if (this.seenMessageIds.size > 2_000)
            this.seenMessageIds.delete(this.seenMessageIds.values().next().value);
        await this.onMessage?.(message);
    }
    scheduleReconnect() {
        if (this.stopping || !this.config || this.reconnectTimer)
            return;
        const delay = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempt);
        this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, 5);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            void this.connect().catch(() => {
                console.warn('[OpenArva Discord] Gateway reconnect failed; retrying.');
                this.scheduleReconnect();
            });
        }, delay);
        this.reconnectTimer.unref();
    }
}
