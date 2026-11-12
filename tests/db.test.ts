import { describe, expect, it } from 'vitest';
import { sql } from '../src/server/db/index.js';
import { testDb } from './fixtures/db.js';

describe('database', () => {
  it('migrates a fresh schema and maps columns to camelCase', async () => {
    const db = await testDb();
    await db.run(
      sql`INSERT INTO memories (id, text, created_at) VALUES (${'m'}, ${'hi'}, ${Date.now()})`,
    );
    const row = await db.row<{ id: string; createdAt: number }>(
      sql`SELECT * FROM memories WHERE id=${'m'}`,
    );
    expect(row?.id).toBe('m');
    expect(typeof row?.createdAt).toBe('number');
  });
  it('composes fragments and numbers placeholders', () => {
    const where = sql.join([sql`a=${1}`, sql`b=${2}`], ' AND ');
    expect(
      sql`SELECT * FROM t WHERE ${where} LIMIT ${sql.raw('5')}`.compile(),
    ).toEqual({
      text: 'SELECT * FROM t WHERE a=$1 AND b=$2 LIMIT 5',
      values: [1, 2],
    });
  });
  it('rolls back a failed transaction and joins nested ones', async () => {
    const db = await testDb();
    await expect(
      db.transaction(async () => {
        await db.run(sql`INSERT INTO memories VALUES (${'a'}, ${'x'}, ${1})`);
        await db.transaction(async () => {
          await db.run(sql`INSERT INTO memories VALUES (${'b'}, ${'y'}, ${2})`);
        });
        throw new Error('stop');
      }),
    ).rejects.toThrow('stop');
    expect(await db.rows(sql`SELECT * FROM memories`)).toEqual([]);
  });
  it('runs migrations once', async () => {
    const db = await testDb();
    const { migrate } = await import('../src/server/db/migrations.js');
    await migrate(db);
    expect(
      (await db.rows(sql`SELECT version FROM schema_migrations`)).length,
    ).toBe(1);
  });
});
