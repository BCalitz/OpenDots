// One-time copy of an OpenDots SQLite database into Postgres.
// Usage: npm run import-sqlite -- [path/to/opendots.sqlite]
// The path defaults to DATABASE_PATH, then data/opendots.sqlite.
import { databaseUrl, openDatabase } from './index.js';
import { importSqlite } from './import-sqlite.js';

const path =
  process.argv[2] ?? process.env.DATABASE_PATH ?? 'data/opendots.sqlite';
const db = await openDatabase(databaseUrl());
try {
  const report = await importSqlite(db, path);
  for (const { table, rows, skipped } of report)
    console.log(
      `${table}: ${rows} row${rows === 1 ? '' : 's'}${skipped.length ? ` (not copied: ${skipped.join(', ')})` : ''}`,
    );
  console.log(`Imported ${path} into Postgres. The SQLite file is unchanged.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await db.close();
}
