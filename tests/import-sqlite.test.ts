import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { importSqlite } from '../src/server/db/import-sqlite.js';
import { ThreadRunner } from '../src/server/engine/thread-runner.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { testDb } from './fixtures/db.js';

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** A SQLite file shaped like one written by the SQLite releases. */
function legacyFile() {
  dir = mkdtempSync(join(tmpdir(), 'opendots-import-'));
  const path = join(dir, 'opendots.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
    INSERT INTO settings VALUES (1, '{"name":"Ada","paused":false,"researchAllowed":false,"memoryAllowed":true,"appsAllowed":false}');
    CREATE TABLE tasks (id TEXT PRIMARY KEY, prompt TEXT NOT NULL, status TEXT NOT NULL, intervalSeconds INTEGER, nextRunAt INTEGER, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, error TEXT, lease TEXT, leaseUntil INTEGER);
    INSERT INTO tasks VALUES ('t1', 'Brief me', 'completed', 3600, 1700000003600000, 1700000000000, 1700000000000, NULL, NULL, NULL);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, taskId TEXT NOT NULL, runId TEXT, text TEXT NOT NULL, createdAt INTEGER NOT NULL);
    INSERT INTO events (taskId, runId, text, createdAt) VALUES ('t1', NULL, 'Task added to the queue.', 1700000000000);
    INSERT INTO events (taskId, runId, text, createdAt) VALUES ('t1', NULL, 'Run completed.', 1700000001000);
    CREATE TABLE spaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, createdAt INTEGER NOT NULL);
    INSERT INTO spaces VALUES ('s1', 'Work', 'Day job', 1);
    CREATE TABLE dots(id TEXT PRIMARY KEY, spaceId TEXT NOT NULL, name TEXT NOT NULL, instructions TEXT NOT NULL, researchAllowed INTEGER NOT NULL, memoryAllowed INTEGER NOT NULL, createdAt INTEGER NOT NULL, learningContainerId TEXT, skillDeliveryEnabled INTEGER NOT NULL DEFAULT 0, appsAllowed INTEGER NOT NULL DEFAULT 0, composioToolkits TEXT NOT NULL DEFAULT '[]');
    INSERT INTO dots (id, spaceId, name, instructions, researchAllowed, memoryAllowed, createdAt, appsAllowed) VALUES ('d1', 's1', 'Scout', 'Find things.', 1, 0, 2, 1);
    CREATE TABLE thread_bindings(id TEXT PRIMARY KEY, dotId TEXT NOT NULL, ownerId TEXT NOT NULL, title TEXT NOT NULL, createdAt INTEGER NOT NULL);
    INSERT INTO thread_bindings VALUES ('th1', 'd1', 'owner', 'Hello', 3);
    CREATE TABLE conv_threads(id TEXT PRIMARY KEY, agentId TEXT NOT NULL, ownerId TEXT NOT NULL, name TEXT, archived INTEGER NOT NULL DEFAULT 0, messages TEXT NOT NULL DEFAULT '[]', createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
    INSERT INTO conv_threads VALUES ('th1', 'd1', 'owner', 'Hello', 1, '[{"id":"m1","role":"user","content":"Hi"}]', 3, 4);
  `);
  db.close();
  return path;
}

it('copies a legacy SQLite file and the stores read it back', async () => {
  const db = await testDb();
  // Starting the app first seeds a Space and Dot; the import replaces them.
  await WorkspaceStore.open(db, 'owner');
  const report = await importSqlite(db, legacyFile());
  expect(report.find((entry) => entry.table === 'dots')?.skipped).toEqual([
    'learningContainerId',
    'skillDeliveryEnabled',
  ]);

  const workspace = new WorkspaceStore(db, 'owner');
  expect(await workspace.spaces()).toEqual([
    { id: 's1', name: 'Work', description: 'Day job', createdAt: 1 },
  ]);
  const [dot] = await workspace.dots();
  expect(dot).toMatchObject({
    id: 'd1',
    spaceIds: ['s1'],
    researchAllowed: true,
    memoryAllowed: false,
    appsAllowed: true,
  });
  expect((await workspace.conversations()).map((c) => c.id)).toEqual(['th1']);

  const store = new Store(db);
  expect((await store.settings()).name).toBe('Ada');
  const detail = await store.detail('t1');
  expect(detail?.task.nextRunAt).toBe(1700000003600000);
  expect(detail?.events.map((event) => event.text)).toEqual([
    'Task added to the queue.',
    'Run completed.',
  ]);
  // New events continue after the imported ids.
  await store.event('t1', null, 'Later.');
  expect((await store.detail('t1'))?.events.map((e) => e.id)).toEqual([
    1, 2, 3,
  ]);

  const runner = new ThreadRunner(db, 'owner');
  expect(await runner.thread('th1')).toMatchObject({ archived: true });
  expect(await runner.messages('th1')).toEqual([
    { id: 'm1', role: 'user', content: 'Hi' },
  ]);
});

it('refuses to import into a database that already has conversations', async () => {
  const db = await testDb();
  const workspace = await WorkspaceStore.open(db, 'owner');
  const [dot] = await workspace.dots();
  await workspace.bindThread('existing', dot.id, 'Existing');
  await expect(importSqlite(db, legacyFile())).rejects.toThrow(
    'already has data',
  );
  expect((await workspace.conversations()).map((c) => c.id)).toEqual([
    'existing',
  ]);
});
