import type { WebConfig } from './parallel.js';
import type { SetupStatus } from '../shared/types.js';
import type { ChannelStatus } from './channels/adapter.js';

export const DEFAULT_AGENT_RUN_TIMEOUT_MS = 90_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function discoveryThresholdFromEnv(
  env: Record<string, string | undefined>,
): number | undefined {
  const raw = env.DISCOVERY_THRESHOLD?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1)
    throw new Error('DISCOVERY_THRESHOLD must be a number from 0 to 1.');
  return value;
}

export function agentRunTimeoutMsFromEnv(
  env: Record<string, string | undefined>,
): number {
  const raw = env.AGENT_RUN_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_AGENT_RUN_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS)
    throw new Error(
      `AGENT_RUN_TIMEOUT_MS must be an integer between 1 and ${MAX_TIMER_DELAY_MS}.`,
    );
  return value;
}

/**
 * Settings from releases that used CopilotKit Intelligence. They no longer
 * do anything; this says so once at startup instead of failing silently.
 */
export function legacySettingsNotice(
  env: Record<string, string | undefined>,
): string | undefined {
  const found = [
    'CONVERSATION_BACKEND',
    'CPK_INTELLIGENCE_API_KEY',
    'INTELLIGENCE_API_KEY',
    'INTELLIGENCE_GATEWAY_WS_URL',
    'INTELLIGENCE_WS_URL',
    'INTELLIGENCE_API_URL',
    'SLACK_CHANNEL_NAME',
  ].filter(
    (name) =>
      env[name]?.trim() &&
      !(
        name === 'CONVERSATION_BACKEND' &&
        env[name]?.trim().toLowerCase() === 'local'
      ),
  );
  if (!found.length) return undefined;
  return `OpenDots no longer uses CopilotKit Intelligence; conversations are stored in this server's database and earlier Intelligence conversations are not imported. Remove ${found.join(', ')} from your settings.${found.includes('SLACK_CHANNEL_NAME') ? ' Slack now connects directly: set SLACK_BOT_TOKEN and SLACK_APP_TOKEN (see docs/SETUP.md#slack).' : ''}`;
}

export interface PlatformConfig extends WebConfig {
  model?: string;
  apiKey?: string;
  baseUrl: string;
  agentRunTimeoutMs?: number;
  computerSupervisorUrl?: string;
  computerSupervisorToken?: string;
  computerToken?: string;
  computerNamespace?: string;
  browserUrl?: string;
  browserSecret?: string;
  composioApiKey?: string;
  /** TypeSafe API key. Discovery is inactive without it. */
  typesafeApiKey?: string;
  /** Lowest confidence — or, for a correlated item, lowest urgency — that
   * still flags an item. Default 0.6. */
  discoveryThreshold?: number;
  /** OpenAI-compatible embeddings endpoint for similar items; off when unset. */
  embeddingBaseUrl?: string;
  /** Default nomic-embed-text. */
  embeddingModel?: string;
  embeddingApiKey?: string;
  voiceKey?: string;
  voiceModel?: string;
  voiceName: string;
  /** Bot token (xoxb-) for replies. */
  slackBotToken?: string;
  /** App-level token (xapp-) for the Socket Mode connection. */
  slackAppToken?: string;
  slackTeam?: string;
  slackUsers: string[];
  slackDotId?: string;
  ownerToken?: string;
}
/** Whether every Slack setting is present, some are, or none. */
export function slackSetup(config: PlatformConfig) {
  const values = [
    config.slackBotToken,
    config.slackAppToken,
    config.slackTeam,
    config.slackUsers.length ? 'users' : '',
  ];
  return values.every(Boolean)
    ? 'configured'
    : values.some(Boolean)
      ? 'partial'
      : 'none';
}
export function setupStatus(
  config: PlatformConfig,
  slack?: ChannelStatus,
): SetupStatus {
  const missing = [
    !config.apiKey && 'OPENAI_API_KEY',
    !config.model && 'OPENAI_MODEL',
  ].filter((item): item is string => !!item);
  const declared = slackSetup(config);
  return {
    model: !!(config.apiKey && config.model),
    browser: !!(config.browserUrl && config.browserSecret),
    voice: !!(config.voiceKey && config.voiceModel && !missing.length),
    composio: !!config.composioApiKey,
    slack:
      declared === 'configured'
        ? (slack ?? 'connecting')
        : declared === 'partial'
          ? 'setup_required'
          : 'not_configured',
    missing,
  };
}
