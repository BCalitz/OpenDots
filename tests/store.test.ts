import { describe, expect, it } from 'vitest';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { pageAccess } from '../src/server/page-tools.js';
import { testDb } from './fixtures/db.js';

async function fixture() {
  const db = await testDb();
  return { store: new Store(db), db };
}
describe('durable task lifecycle', () => {
  it('persists tasks and settings across connections', async () => {
    const { store, db } = await fixture();
    const task = await store.createTask('Compare the sample notebooks', 60);
    await store.updateSettings({ name: 'Sam' });
    const reopened = new Store(db);
    expect((await reopened.task(task.id))?.prompt).toBe(task.prompt);
    expect((await reopened.settings()).name).toBe('Sam');
  });
  it('claims each due job once even through separate store instances', async () => {
    const { store, db } = await fixture();
    await store.createTask('Research one');
    const second = new Store(db);
    const [firstClaim, secondClaim] = await Promise.all([
      store.claim(1000),
      second.claim(1000),
    ]);
    expect([firstClaim, secondClaim].filter(Boolean)).toHaveLength(1);
  });
  it('never overwrites a cancellation with a late result', async () => {
    const { store } = await fixture();
    const task = await store.createTask('Research one');
    const claim = (await store.claim(Date.now()))!;
    await store.action(task.id, 'cancel');
    expect(
      await store.finish(claim, {
        text: 'Late result',
        sources: [],
        sample: true,
      }),
    ).toBe(false);
    expect((await store.task(task.id))?.status).toBe('cancelled');
  });
  it('keeps recurring history and schedules only after completion', async () => {
    const { store } = await fixture();
    const task = await store.createTask('Recurring research', 60);
    const now = Date.now();
    const claim = (await store.claim(now))!;
    await store.finish(
      claim,
      { text: 'First result', sources: [], sample: true },
      now,
    );
    expect(await store.claim(now + 59_000)).toBeNull();
    expect((await store.claim(now + 60_001))?.id).toBe(task.id);
    expect((await store.detail(task.id))?.runs).toHaveLength(2);
  });
  it('global pause invalidates running leases and blocks queued jobs', async () => {
    const { store } = await fixture();
    const task = await store.createTask('Research one');
    const claim = (await store.claim(Date.now()))!;
    await store.updateSettings({ paused: true });
    expect(await store.claim(Date.now())).toBeNull();
    expect(
      await store.finish(claim, {
        text: 'Late result',
        sources: [],
        sample: true,
      }),
    ).toBe(false);
    await store.updateSettings({ paused: false });
    expect(await store.claim(Date.now())).toBeNull();
    expect((await store.task(task.id))?.status).toBe('interrupted');
    await store.action(task.id, 'run');
    expect((await store.claim(Date.now()))?.id).toBe(task.id);
  });
  it.each([180_000, 480_000])(
    'holds expired work until the owner retries it with a %i ms lease',
    async (leaseDurationMs) => {
      const { store, db } = await fixture();
      await store.createTask('Recover me');
      const now = Date.now();
      const old = (await store.claim(now, leaseDurationMs))!;
      const restarted = new Store(db);
      expect(await restarted.claim(now + leaseDurationMs - 1)).toBeNull();
      expect((await restarted.task(old.id))?.status).toBe('running');
      expect(await restarted.claim(now + leaseDurationMs + 1)).toBeNull();
      expect((await restarted.task(old.id))?.status).toBe('interrupted');
      expect((await restarted.detail(old.id))?.runs[0].status).toBe(
        'interrupted',
      );
      await restarted.action(old.id, 'run');
      const recovered = (await restarted.claim(now + leaseDurationMs + 1))!;
      expect(recovered.id).toBe(old.id);
      expect(recovered.lease).not.toBe(old.lease);
      expect(
        await store.finish(old, { text: 'Old', sources: [], sample: true }),
      ).toBe(false);
      expect(
        await restarted.finish(recovered, {
          text: 'New',
          sources: [],
          sample: true,
        }),
      ).toBe(true);
    },
  );
  it('claims other queued work while an expired run waits for review', async () => {
    const { store } = await fixture();
    const interrupted = await store.createTask('Create the first page');
    const now = Date.now();
    const old = (await store.claim(now))!;
    const next = await store.createTask('Research another topic');

    expect((await store.claim(now + 180_001))?.id).toBe(next.id);
    expect((await store.task(interrupted.id))?.status).toBe('interrupted');
    expect((await store.detail(interrupted.id))?.runs[0].status).toBe(
      'interrupted',
    );
    expect(
      await store.finish(old, { text: 'Late', sources: [], sample: true }),
    ).toBe(false);
  });
  it('holds an expired run for review after a local page effect', async () => {
    const { store, db } = await fixture();
    const workspace = await WorkspaceStore.open(db, 'synthetic-owner');
    const dot = (await workspace.dots())[0];
    const thread = await workspace.bindThread(
      'scheduled-thread',
      dot.id,
      'Scheduled work',
    );
    const task = await store.createTask('Create the sample page once');
    await workspace.bindTask(task.id, thread.id);
    const now = Date.now();
    const old = (await store.claim(now))!;
    const pages = await pageAccess(
      workspace,
      dot.spaceId,
      thread.id,
      async () => {},
    );
    await pages.create({ title: 'Sample', content: 'Synthetic fixture body' });

    expect(await store.claim(now + 180_001)).toBeNull();
    expect((await store.task(task.id))?.status).toBe('interrupted');
    expect((await store.detail(task.id))?.runs[0].status).toBe('interrupted');
    expect(await workspace.pages.list(dot.spaceId)).toHaveLength(1);
    expect(
      await store.finish(old, { text: 'Late', sources: [], sample: true }),
    ).toBe(false);

    await store.action(task.id, 'run');
    expect((await store.claim(now + 180_002))?.id).toBe(task.id);
  });
});
