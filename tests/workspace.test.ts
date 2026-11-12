import { expect, it } from 'vitest';
import { WorkspaceStore } from '../src/server/workspace.js';
import { testDb } from './fixtures/db.js';

it('persists spaces, specialist permissions, and canonical thread ownership', async () => {
  const store = await WorkspaceStore.open(await testDb(), 'owner');
  const space = await store.createSpace('Design', 'Design decisions');
  const dot = await store.createDot(
    space.id,
    'Scout',
    'Be concise',
    false,
    true,
  );
  await store.bindThread('thread-1', dot.id, 'Design research');
  expect((await store.requireThread('thread-1', dot.id)).ownerId).toBe('owner');
  await expect(
    store.requireThread('thread-1', 'another-dot'),
  ).rejects.toThrow();
  await expect(store.requireThread('unknown')).rejects.toThrow();
  expect((await store.dot(dot.id))?.researchAllowed).toBe(false);
});
it('rejects a dot in a nonexistent space and does not rebind an existing thread', async () => {
  const store = await WorkspaceStore.open(await testDb(), 'owner');
  await expect(
    store.createDot('missing', 'Dot', 'Help', true, true),
  ).rejects.toThrow();
  const dots = await store.dots();
  await store.bindThread('one', dots[0].id, 'First');
  await expect(store.bindThread('one', dots[0].id, 'Second')).rejects.toThrow();
});

it('never restores revoked Space access on restart', async () => {
  const db = await testDb();
  const ws = await WorkspaceStore.open(db, 'owner');
  const old = await ws.createSpace('Original', '');
  const fresh = await ws.createSpace('New', '');
  const created = await ws.createDot(old.id, 'Dot', 'Help', true, true);
  const dot = (await ws.dot(created.id))!;
  expect(dot.spaceIds).toEqual([old.id]);
  expect(await ws.canAccessSpace(dot.id, fresh.id)).toBe(false);
  await expect(
    ws.updateDot(dot.id, { ...dot, spaceIds: ['missing'] }),
  ).rejects.toThrow();
  expect((await ws.dot(dot.id))?.spaceIds).toEqual([old.id]);
  await ws.bindThread('existing-thread', dot.id, 'Keep me');
  await ws.updateDot(dot.id, {
    ...dot,
    spaceId: fresh.id,
    spaceIds: [fresh.id],
  });
  const reopened = await WorkspaceStore.open(db, 'owner');
  expect((await reopened.dot(dot.id))?.spaceIds).toEqual([fresh.id]);
  expect(await reopened.canAccessSpace(dot.id, old.id)).toBe(false);
  expect((await reopened.requireThread('existing-thread')).dotId).toBe(dot.id);
});
