import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const twilio = require('twilio') as typeof import('twilio');

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = twilio(accountSid, authToken);

export const smsIntegrationStatus = 'partial' as const;

export async function handleIncomingSMS(req: any, res: any) {
  const incomingMsg = req.body.Body;
  const senderNumber = req.body.From;

  const replyText = 'OpenArva received your SMS. Automated SMS agent responses are not implemented yet.';

  await client.messages.create({
    body: replyText,
    from: process.env.TWILIO_PHONE_NUMBER,
    to: senderNumber
  });

  res.send('<Response></Response>');
}