import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import { migrate } from './migrations.js';

// BIGINT (timestamps, counts) and NUMERIC (sums of BIGINT) come back as
// strings by default. Every value OpenDots stores fits in a double.
pg.types.setTypeParser(pg.types.builtins.INT8, Number);
pg.types.setTypeParser(pg.types.builtins.NUMERIC, Number);

/** A query built with the `sql` tag: text with `$n` placeholders and values. */
export class Sql {
  constructor(
    readonly strings: readonly string[],
    readonly values: readonly unknown[],
  ) {}
  /** Flattens nested fragments and numbers the placeholders. */
  compile(): { text: string; values: unknown[] } {
    const values: unknown[] = [];
    const build = (fragment: Sql): string => {
      let text = fragment.strings[0];
      fragment.values.forEach((value, index) => {
        text += value instanceof Sql ? build(value) : `$${values.push(value)}`;
        text += fragment.strings[index + 1];
      });
      return text;
    };
    return { text: build(this), values };
  }
}

/**
 * Parameterised SQL. Interpolated values become placeholders; interpolated
 * `sql` fragments are inlined, so queries can be composed safely.
 */
export function sql(strings: TemplateStringsArray, ...values: unknown[]) {
  return new Sql(strings, values);
}
/** Trusted SQL text, such as a fixed column list or a numeric LIMIT. */
sql.raw = (text: string) => new Sql([text], []);
/** Joins fragments with a separator, e.g. WHERE clauses with ' AND '. */
sql.join = (parts: Sql[], separator: string) =>
  parts.length
    ? new Sql(['', ...parts.slice(1).map(() => separator), ''], parts)
    : sql.raw('');

const camel = (column: string) =>
  column.replace(/_([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());
/** Columns are snake_case in Postgres and camelCase in TypeScript. */
function camelRow(row: Record<string, unknown>) {
  const result: Record<string, unknown> = {};
  for (const key in row) result[camel(key)] = row[key];
  return result;
}

type Client = pg.Pool | pg.PoolClient;
// Any transaction-wide lock works; this one serialises writers the way
// SQLite's BEGIN IMMEDIATE did, which the stores were written against.
const WRITE_LOCK = 0x0d075;

/**
 * The Postgres connection pool. Queries made inside `transaction()` run on
 * that transaction's connection automatically, so store methods compose
 * without passing a client around.
 */
export class Db {
  private current = new AsyncLocalStorage<pg.PoolClient>();
  constructor(
    private pool: pg.Pool,
    private onClose?: () => Promise<void>,
  ) {}
  private get client(): Client {
    return this.current.getStore() ?? this.pool;
  }
  async query(query: Sql) {
    const { text, values } = query.compile();
    return this.client.query(text, values);
  }
  /** All rows, with camelCase keys. */
  async rows<T = Record<string, unknown>>(query: Sql): Promise<T[]> {
    return (await this.query(query)).rows.map(camelRow) as T[];
  }
  /** The first row, if any, with camelCase keys. */
  async row<T = Record<string, unknown>>(query: Sql): Promise<T | undefined> {
    return (await this.rows<T>(query))[0];
  }
  /** Runs a statement and returns how many rows it changed. */
  async run(query: Sql): Promise<number> {
    return (await this.query(query)).rowCount ?? 0;
  }
  /** Runs several statements with no parameters, such as a migration. */
  async exec(text: string) {
    await this.client.query(text);
  }
  get inTransaction() {
    return !!this.current.getStore();
  }
  /**
   * Runs `work` in one transaction. Transactions take a shared lock, so
   * they run one at a time; a nested call joins the outer transaction.
   */
  async transaction<T>(work: () => Promise<T>): Promise<T> {
    if (this.current.getStore()) return work();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [WRITE_LOCK]);
      const value = await this.current.run(client, work);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  async close() {
    await this.pool.end();
    await this.onClose?.();
  }
}

export interface DatabaseOptions {
  /** Use this schema instead of public; tests get one each. */
  schema?: string;
  max?: number;
  /** Stop migrating after this version, so a test can migrate the rest itself. */
  migrateThrough?: number;
}

/** Connects to Postgres and applies any pending migrations. */
export async function openDatabase(
  url: string,
  options: DatabaseOptions = {},
): Promise<Db> {
  const { schema } = options;
  if (schema && !/^[a-z_][a-z0-9_]*$/.test(schema))
    throw new Error('Invalid database schema name.');
  const pool = new pg.Pool({
    connectionString: url,
    max: options.max ?? 10,
    ...(schema ? { options: `-c search_path=${schema},public` } : {}),
  });
  // An idle connection that drops (database restart) must not crash the app.
  pool.on('error', () => undefined);
  try {
    if (schema) await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    const db = new Db(pool);
    await migrate(db, options.migrateThrough);
    return db;
  } catch (error) {
    await pool.end();
    throw error;
  }
}

/** DATABASE_URL, or a clear error when it is missing. */
export function databaseUrl(env: NodeJS.ProcessEnv = process.env) {
  const url = env.DATABASE_URL;
  if (!url)
    throw new Error(
      'Set DATABASE_URL to a Postgres database, e.g. postgres://opendots:opendots@127.0.0.1:5432/opendots. See docs/SETUP.md.',
    );
  return url;
}
