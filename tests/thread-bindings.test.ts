import { expect, it } from 'vitest';
import { sql } from '../src/server/db/index.js';
import { migrate } from '../src/server/db/migrations.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { testDb } from './fixtures/db.js';

it('moves delegation threads onto thread_bindings', async () => {
  const db = await testDb(12);
  await db.run(
    sql`INSERT INTO thread_bindings (id, dot_id, owner_id, title, created_at, parent_id) VALUES ('coord', 'd1', 'owner', 'Coordinator chat', 1, NULL), ('answer', 'd2', 'owner', 'From Ada: research', 2, 'main-d2')`,
  );
  await db.run(
    sql`INSERT INTO delegate_threads VALUES ('coord', 'd2', 'answer')`,
  );
  await migrate(db);
  const workspace = await WorkspaceStore.open(db, 'owner');
  expect(await workspace.delegateThread('coord', 'd2')).toBe('answer');
  expect(await workspace.isDelegateThread('answer')).toBe(true);
  expect(await workspace.isDelegateThread('coord')).toBe(false);
  expect(
    await db.row(sql`SELECT to_regclass('delegate_threads') AS gone`),
  ).toEqual({ gone: null });
  // Still one answering thread per coordinator thread and Dot.
  await expect(
    db.run(
      sql`INSERT INTO thread_bindings (id, dot_id, owner_id, title, created_at, delegated_from) VALUES ('again', 'd2', 'owner', 'Again', 3, 'coord')`,
    ),
  ).rejects.toThrow();
});
