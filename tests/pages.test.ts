import { expect, it } from 'vitest';
import { WorkspaceStore } from '../src/server/workspace.js';
import { sql } from '../src/server/db/index.js';
import { testDb } from './fixtures/db.js';

it('persists nested page content and revision across restart', async () => {
  const db = await testDb();
  let store = await WorkspaceStore.open(db, 'owner');
  const space = (await store.spaces())[0].id;
  const parent = await store.pages.create(space, {
    title: 'Plan',
    content: 'A plan',
  });
  const child = await store.pages.create(space, {
    title: 'Detail',
    parentId: parent.id,
  });
  await store.pages.update(space, child.id, {
    expectedRevision: 1,
    title: 'New detail',
    content: 'Markdown **body**',
  });
  store = await WorkspaceStore.open(db, 'owner');
  expect(await store.pages.get(space, child.id)).toMatchObject({
    title: 'New detail',
    content: 'Markdown **body**',
    revision: 2,
    parentId: parent.id,
  });
});
it('rejects cross-space parents, cycles and stale writes without losing content', async () => {
  const store = await WorkspaceStore.open(await testDb(), 'owner');
  const a = (await store.spaces())[0].id;
  const b = (await store.createSpace('Other', '')).id;
  const root = await store.pages.create(a, { title: 'Root' });
  const child = await store.pages.create(a, {
    title: 'Child',
    parentId: root.id,
  });
  await expect(
    store.pages.create(b, { title: 'Wrong', parentId: root.id }),
  ).rejects.toThrow();
  await expect(
    store.pages.update(a, root.id, { expectedRevision: 1, parentId: child.id }),
  ).rejects.toThrow();
  await store.pages.update(a, root.id, { expectedRevision: 1, content: 'New' });
  await expect(
    store.pages.update(a, root.id, { expectedRevision: 1, content: 'Stale' }),
  ).rejects.toThrow(/changed/);
  expect((await store.pages.get(a, root.id)).content).toBe('New');
  await expect(store.pages.get(b, root.id)).rejects.toThrow();
});
it('retains review receipts and their original draft after restart', async () => {
  const db = await testDb();
  let store = await WorkspaceStore.open(db, 'owner');
  const space = (await store.spaces())[0].id;
  await store.pages.createReviewed(
    space,
    { title: 'Original', content: 'Reviewed content' },
    'thread',
    'call',
  );
  const olderPage = await store.pages.create(space, {
    title: 'Earlier approval',
    content: 'Earlier draft',
  });
  // A receipt from before drafts were stored has no draft.
  await db.run(
    sql`INSERT INTO tool_calls (thread_id, tool_call_id, kind, tool, status, result, created_at) VALUES ('earlier-thread', 'earlier-call', 'page_review', 'review_space_page', 'done', ${JSON.stringify({ pageId: olderPage.id, spaceId: space, draft: null })}, 0)`,
  );
  store = await WorkspaceStore.open(db, 'owner');
  expect(
    (await store.pages.reviewReceipt('thread', 'call'))?.draft,
  ).toMatchObject({
    title: 'Original',
    content: 'Reviewed content',
    spaceId: space,
  });
  await expect(
    store.pages.createReviewed(
      space,
      { title: 'Changed', content: 'Reviewed content' },
      'thread',
      'call',
    ),
  ).rejects.toThrow('different draft');
  expect(
    (await store.pages.reviewReceipt('earlier-thread', 'earlier-call'))?.draft,
  ).toBeNull();
  expect(
    (
      await store.pages.createReviewed(
        space,
        { title: 'Earlier approval', content: 'Earlier draft' },
        'earlier-thread',
        'earlier-call',
      )
    ).id,
  ).toBe(olderPage.id);
});

it('deletes a page and reparents descendants safely', async () => {
  const store = await WorkspaceStore.open(await testDb(), 'owner');
  const space = (await store.spaces())[0].id;
  const root = await store.pages.create(space, { title: 'Root' });
  const child = await store.pages.create(space, {
    title: 'Child',
    parentId: root.id,
  });
  const grandChild = await store.pages.create(space, {
    title: 'Grandchild',
    parentId: child.id,
  });

  // Verify deletion of child: grandChild should be reparented to root
  expect(await store.pages.delete(space, child.id)).toBe(true);
  expect(await store.pages.delete(space, child.id)).toBe(false);
  await expect(store.pages.get(space, child.id)).rejects.toThrow();
  expect((await store.pages.get(space, grandChild.id)).parentId).toBe(root.id);
  // Reparenting bumps the revision so clients holding the old parent resync.
  expect((await store.pages.get(space, grandChild.id)).revision).toBe(
    grandChild.revision + 1,
  );

  // Verify deletion of root: grandChild should be reparented to null (root level)
  expect(await store.pages.delete(space, root.id)).toBe(true);
  expect((await store.pages.get(space, grandChild.id)).parentId).toBeNull();
  expect(await store.pages.list(space)).toHaveLength(1);
  expect((await store.pages.list(space))[0].id).toBe(grandChild.id);

  // Missing space throws
  await expect(
    store.pages.delete('non-existent-space', grandChild.id),
  ).rejects.toThrow(/Space not found/);
});

it('drops page thread bindings on delete and never recreates a page from a retried review', async () => {
  const store = await WorkspaceStore.open(await testDb(), 'owner');
  const space = (await store.spaces())[0].id;
  const page = await store.pages.create(space, { title: 'Draft' });
  await store.pages.reserveThread(page.id, 'dot', 'thread-1');
  await store.pages.finishThread(page.id, 'dot');
  expect(await store.pages.thread(page.id, 'dot')).toBeDefined();
  expect(await store.pages.delete(space, page.id)).toBe(true);
  expect(await store.pages.thread(page.id, 'dot')).toBeUndefined();

  const reviewed = await store.pages.createReviewed(
    space,
    { title: 'Reviewed', content: 'Reviewed content' },
    'review-thread',
    'call-1',
  );
  expect(await store.pages.delete(space, reviewed.id)).toBe(true);
  expect(
    await store.pages.reviewReceipt('review-thread', 'call-1'),
  ).toMatchObject({
    pageId: reviewed.id,
    spaceId: space,
  });
  await expect(
    store.pages.createReviewed(
      space,
      { title: 'Reviewed', content: 'Reviewed content' },
      'review-thread',
      'call-1',
    ),
  ).rejects.toThrow(/Page not found/);
  expect(await store.pages.list(space)).toHaveLength(0);
});
