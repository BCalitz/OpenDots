import { afterEach, expect, it } from 'vitest';
import { testDb, testWorkspace } from './fixtures/db.js';
import { ensureAssistant } from '../src/server/assistant.js';
import { createApp } from '../src/server/app.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import type { AccountSourceConfig } from '../src/shared/inbox-types.js';

const resources: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of resources.splice(0)) await close();
});

const discoverySource = (
  workspace: WorkspaceStore,
  dotId: string,
  accountId: string,
) =>
  workspace.inbox.create({
    name: `Gmail (${accountId})`,
    kind: 'mail',
    type: 'account',
    config: { dotId, userId: workspace.ownerId, accountId, app: 'gmail' },
    notify: 'off',
    intervalSeconds: 300,
  });
const sourceDots = async (workspace: WorkspaceStore) =>
  (await workspace.inbox.accountSources()).map(
    (source) => (source.config as AccountSourceConfig).dotId,
  );

it('creates one assistant Dot on a fresh install', async () => {
  const { store, workspace } = await testWorkspace();
  const assistant = await ensureAssistant(store, workspace);
  const dots = await workspace.dots();
  expect(dots).toHaveLength(1);
  expect(dots[0]).toMatchObject({
    id: assistant.id,
    name: 'Assistant',
    researchAllowed: true,
    memoryAllowed: true,
  });
  expect((await workspace.computers.permissions(assistant.id)).enabled).toBe(
    false,
  );
  expect((await store.settings()).assistantDotId).toBe(assistant.id);
});

it('keeps an existing install’s Dot as it is', async () => {
  const db = await testDb();
  const before = new WorkspaceStore(db, 'owner');
  const space = await before.createSpace('Everyday', '');
  const dot = await before.createDot(space.id, 'Dot', 'Help', true, true);
  const workspace = await WorkspaceStore.open(db, 'owner');
  const assistant = await ensureAssistant(new Store(db), workspace);
  expect(assistant).toMatchObject({ id: dot.id, name: 'Dot' });
  expect(await workspace.dots()).toHaveLength(1);
});

it('keeps every Dot and picks the one discovery already uses', async () => {
  const { store, workspace } = await testWorkspace();
  const space = (await workspace.spaces())[0];
  const second = await workspace.createDot(space.id, 'Scout', '', true, true);
  const third = await workspace.createDot(space.id, 'Writer', '', true, true);
  await discoverySource(workspace, second.id, 'work');
  const assistant = await ensureAssistant(store, workspace);
  expect(assistant.id).toBe(second.id);
  expect(await workspace.dots()).toHaveLength(3);
  expect((await store.settings()).assistantDotId).toBe(second.id);
  // Once chosen, the choice stays.
  await discoverySource(workspace, third.id, 'home');
  expect((await ensureAssistant(store, workspace)).id).toBe(second.id);
  // And every discovery source follows it.
  expect(await sourceDots(workspace)).toEqual([second.id, second.id]);
});

it('picks the oldest Dot when discovery is not set up', async () => {
  const { store, workspace } = await testWorkspace();
  const oldest = (await workspace.dots())[0];
  await workspace.createDot(oldest.spaceId, 'Scout', '', true, true);
  expect((await ensureAssistant(store, workspace)).id).toBe(oldest.id);
});

it('chooses again when the saved assistant no longer exists', async () => {
  const { store, workspace } = await testWorkspace();
  await store.updateSettings({ assistantDotId: 'gone' });
  const oldest = (await workspace.dots())[0];
  expect((await ensureAssistant(store, workspace)).id).toBe(oldest.id);
  expect((await store.settings()).assistantDotId).toBe(oldest.id);
});

it('changes the assistant in settings, and discovery follows it', async () => {
  const { store, workspace } = await testWorkspace();
  const first = (await workspace.dots())[0];
  const second = await workspace.createDot(
    first.spaceId,
    'Scout',
    '',
    true,
    true,
  );
  const source = await discoverySource(workspace, first.id, 'work');
  const platform = await Platform.create(store, workspace, {
    apiKey: 'fixture',
    model: 'custom-model',
    baseUrl: 'https://unused.invalid/v1',
    voiceName: 'marin',
    slackUsers: [],
  });
  resources.push(() => platform.stop());
  expect((await store.settings()).assistantDotId).toBe(first.id);
  const config = {
    mode: 'live' as const,
    baseUrl: 'https://unused.invalid/v1',
  };
  const app = createApp({
    store,
    runner: new Runner(store, config),
    config,
    platform,
  });
  const patch = (body: unknown) =>
    app.request('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const missing = await patch({ assistantDotId: 'missing' });
  expect(missing.status).toBe(400);
  expect(await missing.json()).toEqual({ error: 'Dot not found.' });
  expect((await store.settings()).assistantDotId).toBe(first.id);

  const changed = await patch({ assistantDotId: second.id });
  expect(changed.status).toBe(200);
  expect((await changed.json()).assistantDotId).toBe(second.id);
  expect(await sourceDots(workspace)).toEqual([second.id]);
  expect((await workspace.inbox.source(source.source.id))?.enabled).toBe(true);
});
