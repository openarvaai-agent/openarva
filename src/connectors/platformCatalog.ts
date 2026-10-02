export type ConnectorCategory =
  | 'enterprise-chat'
  | 'consumer-messaging'
  | 'social-messaging'
  | 'developer-notifications'
  | 'email-sms-voice';

export type ConnectorReadiness = 'implemented' | 'partial' | 'placeholder' | 'interface';

export interface PlatformDescriptor {
  id: string;
  name: string;
  category: ConnectorCategory;
  protocols: string[];
  readiness: ConnectorReadiness;
  requiredEnv: string[];
  notes?: string;
}

type CatalogEntry = [string, string, string[], ...[ConnectorReadiness?, string[]?, string?]];
const groups: Array<[ConnectorCategory, CatalogEntry[]]> = [
  ['enterprise-chat', [
    ['discord', 'Discord', ['websocket', 'rest'], 'implemented', ['DISCORD_BOT_TOKEN', 'DISCORD_ALLOWED_CHANNEL_IDS'], 'Discord Gateway message events and REST text replies; the Message Content Intent must be enabled.'],
    ['slack', 'Slack', ['events-api', 'websocket', 'oauth2'], 'placeholder'],
    ['microsoft-teams', 'Microsoft Teams', ['bot-framework', 'webhook', 'oauth2'], 'placeholder'],
    ['mattermost', 'Mattermost', ['websocket', 'rest', 'webhook'], 'placeholder'],
    ['rocket-chat', 'Rocket.Chat', ['websocket', 'rest', 'webhook'], 'placeholder'],
    ['zulip', 'Zulip', ['events-api', 'rest', 'webhook'], 'placeholder'],
    ['matrix', 'Matrix / Element', ['matrix-sync', 'websocket'], 'placeholder'],
    ['guilded', 'Guilded', ['websocket', 'rest'], 'placeholder'],
    ['revolt', 'Revolt', ['websocket', 'rest'], 'placeholder'],
    ['gitter', 'Gitter', ['websocket', 'rest'], 'placeholder'],
  ]],
  ['consumer-messaging', [
    ['telegram', 'Telegram', ['bot-api', 'polling'], 'implemented', ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_CHAT_IDS']],
    ['whatsapp', 'WhatsApp (Twilio)', ['rest', 'signed-webhook'], 'implemented', ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'], 'Twilio WhatsApp only; the Meta Cloud API is not implemented.'],
    ['imessage', 'iMessage', ['macos-automation'], 'placeholder', [], 'macOS-only OSA bridge is not implemented.'],
    ['wechat', 'WeChat', ['official-account-api', 'webhook'], 'placeholder'],
    ['signal', 'Signal', ['signal-bridge'], 'placeholder', [], 'Requires a separately deployed Signal bridge.'],
    ['line', 'LINE', ['messaging-api', 'webhook'], 'placeholder'],
    ['viber', 'Viber', ['bot-api', 'webhook'], 'placeholder'],
    ['kakaotalk', 'KakaoTalk', ['business-api', 'webhook'], 'placeholder'],
    ['telegram-x', 'Telegram X', ['unsupported-client'], 'placeholder', [], 'No supported Telegram X bot API exists in this connector.'],
    ['imo', 'IMO', ['unsupported-client'], 'placeholder'],
    ['bbm-enterprise', 'BBM Enterprise', ['enterprise-api'], 'placeholder'],
    ['threema', 'Threema', ['gateway-api', 'webhook'], 'placeholder'],
    ['session', 'Session', ['community-api'], 'placeholder'],
    ['zalo', 'Zalo', ['official-account-api', 'webhook'], 'placeholder'],
    ['qq', 'QQ', ['bot-api', 'webhook'], 'placeholder'],
    ['telegram-bot-api', 'Telegram Bot API', ['bot-api', 'polling'], 'placeholder', [], 'Use the implemented telegram connector; this ID is catalogued for explicit naming.'],
  ]],
  ['social-messaging', [
    ['instagram-direct', 'Instagram Direct', ['graph-api', 'webhook'], 'placeholder'],
    ['facebook-messenger', 'Facebook Messenger', ['graph-api', 'webhook'], 'placeholder'],
    ['x-dm', 'X (Twitter) DMs', ['rest', 'webhook'], 'placeholder'],
    ['linkedin-messaging', 'LinkedIn Messaging', ['partner-api'], 'placeholder'],
    ['reddit-dm', 'Reddit DMs', ['rest', 'oauth2'], 'placeholder'],
    ['tiktok-dm', 'TikTok DMs', ['business-api'], 'placeholder'],
    ['threads', 'Threads API', ['graph-api', 'webhook'], 'placeholder'],
    ['mastodon', 'Mastodon', ['activitypub', 'streaming-api'], 'placeholder'],
    ['snapchat-enterprise', 'Snapchat Enterprise', ['enterprise-api', 'webhook'], 'placeholder'],
  ]],
  ['developer-notifications', [
    ['github', 'GitHub Discussions / Issues', ['webhook', 'rest', 'graphql'], 'placeholder', [], 'The repository crawler is not an inbound/outbound messaging connector.'],
    ['gitlab', 'GitLab', ['webhook', 'rest'], 'placeholder'],
    ['bitbucket', 'Bitbucket', ['webhook', 'rest'], 'placeholder'],
    ['jira', 'Jira', ['webhook', 'rest', 'oauth2'], 'placeholder'],
    ['trello', 'Trello', ['webhook', 'rest'], 'placeholder'],
    ['asana', 'Asana', ['webhook', 'rest', 'oauth2'], 'placeholder'],
    ['clickup', 'ClickUp', ['webhook', 'rest', 'oauth2'], 'placeholder'],
    ['notion', 'Notion', ['webhook', 'rest', 'oauth2'], 'placeholder'],
    ['monday', 'Monday.com', ['webhook', 'graphql', 'oauth2'], 'placeholder'],
    ['linear', 'Linear', ['webhook', 'graphql', 'oauth2'], 'placeholder'],
    ['pagerduty', 'PagerDuty', ['webhook', 'rest'], 'placeholder'],
    ['opsgenie', 'Opsgenie', ['webhook', 'rest'], 'placeholder'],
  ]],
  ['email-sms-voice', [
    ['smtp-imap', 'SMTP / IMAP Email', ['smtp', 'imap'], 'placeholder', [], 'The desktop TradingView IMAP workflow is separate and is not a universal email connector.'],
    ['twilio-sms-voice', 'Twilio SMS / Voice', ['rest', 'signed-webhook'], 'partial', ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'], 'WhatsApp messaging is implemented; general SMS and voice automation are not.'],
    ['sendgrid', 'SendGrid', ['rest', 'webhook'], 'placeholder'],
    ['plivo', 'Plivo', ['rest', 'signed-webhook'], 'placeholder'],
    ['messagebird', 'MessageBird', ['rest', 'signed-webhook'], 'placeholder'],
    ['telnyx', 'Telnyx', ['rest', 'signed-webhook'], 'placeholder'],
    ['amazon-ses-sns', 'Amazon SES / SNS', ['smtp', 'rest', 'signed-webhook'], 'placeholder'],
    ['pushbullet', 'Pushbullet', ['rest', 'websocket'], 'placeholder'],
    ['pushover', 'Pushover', ['rest'], 'placeholder'],
    ['gotify', 'Gotify', ['rest', 'websocket'], 'placeholder'],
    ['webpush-vapid', 'WebPush (VAPID)', ['webpush'], 'placeholder'],
  ]],
];

export const platformCatalog: PlatformDescriptor[] = groups.flatMap(([category, entries]) =>
  entries.map(([id, name, protocols, readiness = 'placeholder', requiredEnv = [], notes]) => ({
    id,
    name,
    category,
    protocols,
    readiness,
    requiredEnv,
    ...(notes ? { notes } : {}),
  })),
);

export function getPlatformDescriptor(id: string) {
  return platformCatalog.find((platform) => platform.id === id);
}
