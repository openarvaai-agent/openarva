import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const twilio = require('twilio') as {
  validateRequest(authToken: string, signature: string, url: string, params: Record<string, unknown>): boolean;
};

export function verifyTwilioWebhook(authToken: string | undefined, signature: string | undefined, configuredUrl: string | undefined, params: Record<string, unknown>) {
  if (!authToken || !signature || !configuredUrl) return false;
  try {
    return twilio.validateRequest(authToken, signature, configuredUrl, params);
  } catch {
    return false;
  }
}