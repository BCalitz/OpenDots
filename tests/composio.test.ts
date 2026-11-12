import { afterEach, expect, it, vi } from 'vitest';
import { testWorkspace } from './fixtures/db.js';
import type { PlatformConfig } from '../src/server/platform-config.js';

const sdk = vi.hoisted(() => ({
  create: vi.fn(),
  use: vi.fn(),
  constructor: vi.fn(),
}));
vi.mock('@composio/core', () => ({
  Composio: class {
    sessions = { create: sdk.create, use: sdk.use };
    constructor(options: unknown) {
      sdk.constructor(options);
    }
  },
}));

const config: PlatformConfig = {
  composioApiKey: 'composio-fixture',
  baseUrl: 'https://example.com',
  voiceName: 'marin',
  slackUsers: [],
};
afterEach(() => {
  vi.clearAllMocks();
});

it('creates a non-Instant session and reuses it while the policy is unchanged', async () => {
  const { composioSession } = await import('../src/server/composio.js');
  const { workspace } = await testWorkspace();
  const original = (await workspace.dots())[0];
  await workspace.updateDot(original.id, {
    ...original,
    appsAllowed: true,
    composioToolkits: ['gmail'],
  });
  const created = { sessionId: 'session-one' };
  sdk.create.mockResolvedValue(created);
  sdk.use.mockResolvedValue(created);
  const signal = new AbortController().signal;

  await expect(
    composioSession(
      config,
      workspace,
      (await workspace.dot(original.id))!,
      'owner',
      signal,
    ),
  ).resolves.toBe(created);
  expect(sdk.create).toHaveBeenCalledWith(
    'owner',
    {
      toolkits: ['gmail'],
      manageConnections: true,
      instant: false,
    },
    { signal },
  );

  await composioSession(
    config,
    workspace,
    (await workspace.dot(original.id))!,
    'owner',
    signal,
  );
  expect(sdk.create).toHaveBeenCalledTimes(1);
  expect(sdk.use).toHaveBeenCalledWith('session-one', undefined, { signal });
});

it('creates a new session when the toolkit policy changes', async () => {
  const { composioSession } = await import('../src/server/composio.js');
  const { workspace } = await testWorkspace();
  const dot = (await workspace.dots())[0];
  sdk.create
    .mockResolvedValueOnce({ sessionId: 'session-one' })
    .mockResolvedValueOnce({ sessionId: 'session-two' });

  await composioSession(config, workspace, dot, 'owner');
  await workspace.updateDot(dot.id, {
    ...(await workspace.dot(dot.id))!,
    composioToolkits: ['gmail'],
  });
  await composioSession(
    config,
    workspace,
    (await workspace.dot(dot.id))!,
    'owner',
  );

  expect(sdk.create).toHaveBeenCalledTimes(2);
  expect(sdk.use).not.toHaveBeenCalled();
  expect((await workspace.dot(dot.id))?.composioSessionId).toBe('session-two');
});

it('keeps Composio optional in setup status', async () => {
  const { setupStatus } = await import('../src/server/platform-config.js');
  const without = setupStatus({ ...config, composioApiKey: undefined });
  expect(without.composio).toBe(false);
  expect(without.missing).not.toContain('COMPOSIO_API_KEY');
  expect(setupStatus(config).composio).toBe(true);
});
