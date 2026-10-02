import { FixedWindowRateLimiter } from '../security/rateLimit.js';
import { fetchPublicHttp } from '../security/network.js';
async function telegramRequest(token, method, payload, signal) {
    const url = `https://api.telegram.org/bot${token}/${method}${method === 'getUpdates' && payload ? `?${new URLSearchParams(Object.entries(payload).map(([key, value]) => [key, String(value)]))}` : ''}`;
    const response = await fetchPublicHttp(url, {
        ...(payload && method !== 'getUpdates' ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) } : {}),
        signal,
        allowJson: true,
        maxBytes: 1_000_000,
        maxRedirects: 0,
    });
    const result = JSON.parse(response.body.toString('utf8'));
    if (!result.ok)
        throw new Error(result.description || `Telegram API ${method} failed.`);
    return result.result;
}
export function startBot() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
        console.log('⚠️ [Telegram] No token provided, Telegram bot disabled.');
        return;
    }
    const allowedChatIds = new Set((process.env.TELEGRAM_ALLOWED_CHAT_IDS || '').split(',').map((id) => id.trim()).filter(Boolean));
    if (allowedChatIds.size === 0) {
        console.warn('⚠️ [Telegram] Inbound processing disabled: configure TELEGRAM_ALLOWED_CHAT_IDS with trusted chat IDs.');
        return;
    }
    let offset = 0;
    const rateLimiter = new FixedWindowRateLimiter(30, 60_000);
    console.log('🤖 [OpenArva Telegram Bot] Starting...');
    console.log('💬 Listening for messages on Telegram...');
    // Continuous polling loop
    const poll = async () => {
        while (true) {
            try {
                const updates = await telegramRequest(token, 'getUpdates', { timeout: 20, offset, allowed_updates: '["message"]' }, AbortSignal.timeout(25_000));
                if (updates) {
                    for (const update of updates) {
                        offset = update.update_id + 1;
                        const message = update.message;
                        if (!message?.text)
                            continue;
                        const chatId = String(message.chat.id);
                        if (!allowedChatIds.has(chatId) || !rateLimiter.allow(chatId)) {
                            console.warn(`[Telegram] Ignored message from unauthorized or rate-limited chat ${chatId}.`);
                            continue;
                        }
                        console.log(`[Telegram] Accepted message from chat ${chatId} (${message.text.length} characters).`);
                        const userMsg = message.text;
                        let reply;
                        if (userMsg.startsWith('/cmd ')) {
                            reply = 'Remote command execution is disabled. Use OpenArva locally for approval-gated system actions.';
                        }
                        else {
                            console.log('[Telegram] Processing approved chat message.');
                            reply = await askOpenArva(userMsg);
                        }
                        await telegramRequest(token, 'sendMessage', {
                            chat_id: message.chat.id,
                            text: reply.slice(0, 4096),
                        });
                    }
                }
            }
            catch (err) {
                console.error('[Telegram] Polling error:', err);
                // Error ቢፈጠር እንኳን ትንሽ ቆይቶ እንዲቀጥል
                await new Promise((res) => setTimeout(res, 3000));
            }
        }
    };
    // function-ኡን እዚህ ጋር እንጠራዋለን!
    poll();
}
