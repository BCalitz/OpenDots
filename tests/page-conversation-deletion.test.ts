import { expect, it, vi } from 'vitest';
import { WorkspaceStore } from '../src/server/workspace.js';
import { PageService } from '../src/server/page-service.js';
import { testDb } from './fixtures/db.js';

it('does not bind a conversation when its page is deleted during thread creation', async () => {
  const ws = await WorkspaceStore.open(await testDb(), 'owner');
  const dot = (await ws.dots())[0];
  const page = await ws.pages.create(dot.spaceId, { title: 'Temporary' });
  let resolve!: () => void;
  const remote = new Promise<void>((done) => {
    resolve = done;
  });
  const getOrCreateThread = vi.fn(() => remote);
  const service = new PageService(ws, () => ({
    getOrCreateThread,
    getThreadMessages: async () => ({ messages: [] }),
  }));
  const pending = service.conversation(dot.spaceId, page.id, dot.id);
  const outcome = expect(pending).rejects.toThrow(/Page not found/);
  await vi.waitFor(() => expect(getOrCreateThread).toHaveBeenCalledTimes(1));
  await ws.pages.delete(dot.spaceId, page.id);
  resolve();
  await outcome;
  expect(await ws.conversations()).toHaveLength(0);
  expect(await ws.pages.thread(page.id, dot.id)).toBeUndefined();
  const replacement = await ws.pages.create(dot.spaceId, {
    title: 'Replacement',
  });
  const thread = await service.conversation(
    dot.spaceId,
    replacement.id,
    dot.id,
  );
  expect((await ws.pages.forThread(thread.id))?.id).toBe(replacement.id);
});
