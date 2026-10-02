import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { FixedWindowRateLimiter } from '../security/rateLimit.js';
export const webConnectorStatus = 'placeholder';
export function startWebGateway(config = {}) {
    const PORT = config.port ?? Number(process.env.OPENARVA_PORT || 3000);
    const HOST = config.host || process.env.OPENARVA_HOST || '127.0.0.1';
    const AUTH_SECRET = config.authSecret || process.env.OPENARVA_AUTH_KEY;
    const rateLimiter = new FixedWindowRateLimiter(60, 60_000, 10_000);
    if (!['127.0.0.1', '::1', 'localhost'].includes(HOST) && !AUTH_SECRET) {
        throw new Error('OPENARVA_AUTH_KEY is required before binding the standalone web placeholder to a non-loopback host.');
    }
    // 1. የደህንነት ማረጋገጫ (Authentication Middleware)
    const authenticateRequest = (req, res) => {
        const authHeader = req.headers.authorization;
        // API Key ካልተዋቀረ ወይም ከተላከው ጋር ካልተመሳሰል ጥያቄውን ውድቅ ያደርጋል
        if (AUTH_SECRET && (!authHeader || authHeader !== `Bearer ${AUTH_SECRET}`)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: 'ያልተፈቀደ መግቢያ! ትክክለኛ Authorization Bearer Token ያቅርቡ።'
            }));
            return false;
        }
        return true;
    };
    // 2. REST API Endpoint (ለ ሞባይል አፕሊኬሽኖች እና Webhooks)
    const server = createServer((req, res) => {
        if (req.method !== 'POST' || req.url !== '/api/v1/chat') {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Not found' }));
            return;
        }
        if (!authenticateRequest(req, res))
            return;
        if (!rateLimiter.allow(req.socket.remoteAddress || '')) {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Rate limit exceeded.' }));
            return;
        }
        res.writeHead(501, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, integration: 'placeholder', error: 'Standalone web chat is not connected to the OpenArva agent.' }));
    });
    // HTTP Server Start
    server.listen(PORT, HOST, () => {
        console.warn(`[OpenArva Web] Placeholder transport listening on ${HOST}:${PORT}; chat processing is not implemented.`);
    });
    // Real-time WebSocket Gateway
    const wss = new WebSocketServer({ server });
    wss.on('connection', (ws) => {
        ws.send(JSON.stringify({ status: 'unavailable', integration: 'placeholder', error: 'Standalone web chat is not connected to the OpenArva agent.' }));
        ws.close(1013, 'Standalone web integration is not implemented.');
    });
}
