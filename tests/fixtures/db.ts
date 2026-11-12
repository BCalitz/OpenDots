import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, onTestFinished } from 'vitest';
import { openDatabase, type Db } from '../../src/server/db/index.js';
import { Store } from '../../src/server/store.js';
import { WorkspaceStore } from '../../src/server/workspace.js';

/**
 * The Postgres server tests run against. Start one with
 * `npm run test:db` (Docker), or point TEST_DATABASE_URL at your own.
 */
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://opendots:opendots@127.0.0.1:54329/opendots_test';

const dropSchema = async (schema: string) => {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } finally {
    await client.end();
  }
};

/**
 * A fresh, migrated database in its own schema. It is dropped when the
 * current test ends, or after the file when created outside a test.
 */
export async function testDb(migrateThrough?: number): Promise<Db> {
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  let db: Db;
  try {
    db = await openDatabase(TEST_DATABASE_URL, {
      schema,
      max: 4,
      migrateThrough,
    });
  } catch (error) {
    throw new Error(
      `Tests need Postgres at ${TEST_DATABASE_URL}. Run \`npm run test:db\` or set TEST_DATABASE_URL. (${error instanceof Error ? error.message : String(error)})`,
      { cause: error },
    );
  }
  let closed = false;
  const dispose = async () => {
    if (closed) return;
    closed = true;
    await db.close().catch(() => undefined);
    await dropSchema(schema);
  };
  try {
    onTestFinished(dispose);
  } catch {
    afterAll(dispose);
  }
  return db;
}

/** A fresh database with the task store and a seeded workspace on it. */
export async function testWorkspace(ownerId = 'owner') {
  const db = await testDb();
  return {
    db,
    store: new Store(db),
    workspace: await WorkspaceStore.open(db, ownerId),
  };
}
