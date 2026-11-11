import { expect, it } from 'vitest';
import {
  legacySettingsNotice,
  setupStatus,
  type PlatformConfig,
} from '../src/server/platform-config.js';
const config: PlatformConfig = {
  apiKey: 'fixture',
  model: 'fixture',
  baseUrl: 'https://example.com',
  voiceName: 'marin',
  slackUsers: [],
};
const slack = {
  ...config,
  slackBotToken: 'xoxb-fixture',
  slackAppToken: 'xapp-fixture',
  slackTeam: 'T1',
  slackUsers: ['U1'],
};
it('never claims Slack online without every Slack setting', () => {
  expect(setupStatus(config, 'online').slack).toBe('not_configured');
  expect(
    setupStatus({ ...config, slackBotToken: 'xoxb-fixture' }, 'online').slack,
  ).toBe('setup_required');
  expect(
    setupStatus({ ...slack, slackAppToken: undefined }, 'online').slack,
  ).toBe('setup_required');
  expect(setupStatus(slack, 'online').slack).toBe('online');
  expect(setupStatus(slack, 'activation_failed').slack).toBe(
    'activation_failed',
  );
  expect(setupStatus(slack).slack).toBe('connecting');
});
it('requires only model setup and disables voice without it', () => {
  expect(setupStatus(config).missing).toEqual([]);
  expect(
    setupStatus({
      ...config,
      apiKey: undefined,
      voiceKey: 'fixture',
      voiceModel: 'fixture',
    }),
  ).toMatchObject({ missing: ['OPENAI_API_KEY'], voice: false });
});
it('says once that Intelligence settings no longer do anything', () => {
  expect(legacySettingsNotice({})).toBeUndefined();
  expect(
    legacySettingsNotice({ CONVERSATION_BACKEND: 'local' }),
  ).toBeUndefined();
  const notice = legacySettingsNotice({
    CONVERSATION_BACKEND: 'intelligence',
    CPK_INTELLIGENCE_API_KEY: 'cpk-key',
    SLACK_CHANNEL_NAME: 'opendots',
  });
  expect(notice).toContain(
    'Remove CONVERSATION_BACKEND, CPK_INTELLIGENCE_API_KEY, SLACK_CHANNEL_NAME',
  );
  expect(notice).toContain('SLACK_BOT_TOKEN');
  // The notice names settings, never their values.
  expect(notice).not.toContain('cpk-key');
});
