import { webSearchProvider } from './parallel.js';
import { createShutdown } from './shutdown.js';
import { reportChannelFailure, safeFailure } from './channels/adapter.js';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Store } from './store.js';
import { databaseUrl, openDatabase } from './db/index.js';
import { Runner } from './runner.js';
import { createApp } from './app.js';
import { resolveAppOrigins } from './app-origin.js';
import { WorkspaceStore } from './workspace.js';
import { Platform } from './platform.js';
import { signInConnectors } from './connectors/sign-in.js';
import { PushService, scheduledResultMessage } from './push.js';
import { pushNotifier } from './inbox/notify.js';
import {
  agentRunTimeoutMsFromEnv,
  discoveryThresholdFromEnv,
  legacySettingsNotice,
  type PlatformConfig,
} from './platform-config.js';
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 4310);
const ownerToken = process.env.OWNER_TOKEN;
if (
  !['127.0.0.1', '::1', 'localhost'].includes(host) &&
  (!ownerToken || ownerToken.length < 24)
)
  throw new Error(
    'External binding requires an OWNER_TOKEN of at least 24 characters.',
  );
if (process.env.DATABASE_PATH)
  console.warn(
    'DATABASE_PATH is no longer read: OpenDots stores its data in Postgres (DATABASE_URL). Copy an existing SQLite file with `npm run import-sqlite`; see docs/SETUP.md.',
  );
const db = await openDatabase(databaseUrl());
const store = new Store(db);
const push = new PushService(db, {
  accessToken: process.env.EXPO_ACCESS_TOKEN || undefined,
  previews: process.env.PUSH_PREVIEWS === 'true',
});
const workspace = await WorkspaceStore.open(
  db,
  process.env.OWNER_ID ?? 'opendots-owner',
  process.env.SECRETS_KEY || undefined,
);
const config: PlatformConfig = {
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_MODEL,
  baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
  agentRunTimeoutMs: agentRunTimeoutMsFromEnv(process.env),
  webSearchProvider: webSearchProvider(process.env.WEB_SEARCH_PROVIDER),
  parallelApiKey: process.env.PARALLEL_API_KEY,
  browserUrl: process.env.BROWSER_URL,
  browserSecret: process.env.BROWSER_SECRET,
  typesafeApiKey: process.env.TYPESAFE_API_KEY || undefined,
  discoveryThreshold: discoveryThresholdFromEnv(process.env),
  computerSupervisorUrl: process.env.COMPUTER_SUPERVISOR_URL,
  computerSupervisorToken: process.env.COMPUTER_SUPERVISOR_TOKEN,
  computerToken: process.env.COMPUTER_TOKEN,
  computerNamespace: process.env.COMPUTER_NAMESPACE,
  voiceKey: process.env.VOICE_API_KEY,
  voiceModel: process.env.VOICE_MODEL,
  voiceName: process.env.VOICE_NAME ?? 'marin',
  slackBotToken: process.env.SLACK_BOT_TOKEN || undefined,
  slackAppToken: process.env.SLACK_APP_TOKEN || undefined,
  slackTeam: process.env.SLACK_TEAM_ID,
  slackUsers: (process.env.SLACK_USER_IDS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  slackDotId: process.env.SLACK_DOT_ID || undefined,
  ownerToken,
};
const platform = await Platform.create(store, workspace, config, {
  push,
  signIn: signInConnectors(process.env),
  publicUrl: (process.env.PUBLIC_URL || `http://127.0.0.1:${port}`).replace(
    /\/+$/,
    '',
  ),
});
console.log('Conversations are stored in Postgres.');
const legacy = legacySettingsNotice(process.env);
if (legacy) console.warn(legacy);
const researchConfig = {
  mode: 'live' as const,
  apiKey: config.apiKey,
  model: config.model,
  baseUrl: config.baseUrl,
  webSearchProvider: config.webSearchProvider,
  parallelApiKey: config.parallelApiKey,
  browserUrl: config.browserUrl,
  browserSecret: config.browserSecret,
};
const runner = new Runner(
  store,
  researchConfig,
  async (claim, _memories, signal, progress) => {
    const threadId = await workspace.taskThread(claim.id);
    if (!threadId)
      throw new Error(
        'This legacy task has no conversation. Create a new scheduled task from a conversation.',
      );
    progress('Running this task in its conversation.');
    const notify = async (outcome: { text: string } | { error: string }) => {
      const dotId = (await workspace.conversation(threadId))?.dotId;
      const dotName =
        (dotId && (await workspace.dot(dotId))?.name) || 'Your Dot';
      await push.send(scheduledResultMessage(push, dotName, threadId, outcome));
    };
    try {
      const text = await platform.turn(threadId, claim.prompt, signal, {
        opendotsSource: 'scheduled_task',
      });
      void notify({ text }).catch(() => undefined);
      return { text, sources: [], sample: false };
    } catch (error) {
      // A stopped or cancelled run is the owner's own action; stay quiet.
      if (!signal.aborted)
        void notify({
          error:
            error instanceof Error ? error.message : 'The run did not finish.',
        }).catch(() => undefined);
      throw error;
    }
  },
  config.agentRunTimeoutMs,
);
const app = createApp({
  store,
  runner,
  config: researchConfig,
  ownerToken,
  origin: resolveAppOrigins(process.env.APP_ORIGIN, process.env.NODE_ENV),
  platform,
  push,
});
app.use('*', async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header(
    'Content-Security-Policy',
    `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
  );
  await next();
});
app.get('/api/*', (c) => c.json({ error: 'Not found.' }, 404));
// In development Vite serves the client; only the built app is served from dist/client.
if (process.env.NODE_ENV !== 'development') {
  app.use('/*', serveStatic({ root: './dist/client' }));
  app.get('*', serveStatic({ path: './dist/client/index.html' }));
}
const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  console.log(`OpenDots template listening on http://${host}:${info.port}`);
  runner.start();
  platform.inbox.onEvents(pushNotifier(push));
  platform.inbox.start();
  void platform
    .start()
    .catch((error) =>
      reportChannelFailure('Slack failed to connect; check setup status', [
        safeFailure(error),
      ]),
    );
});
const shutdown = createShutdown({
  stopRunner: () => runner.stop(),
  stopPlatform: () => platform.stop(),
  closeServer: () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    ),
  closeDatabase: () => db.close(),
  exit: (code) => process.exit(code),
  report: (operation, error) =>
    reportChannelFailure(operation, [safeFailure(error)]),
});
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
