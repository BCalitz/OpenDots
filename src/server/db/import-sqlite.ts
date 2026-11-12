import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { sql, type Db } from './index.js';
import { RETIRE_COMPOSIO_SOURCES } from './migrations.js';

/** Tables copied from an OpenDots SQLite file, parents before children. */
const TABLES = [
  'setup_telemetry',
  'settings',
  'tasks',
  'runs',
  'events',
  'memories',
  'spaces',
  'dots',
  'dot_spaces',
  'thread_bindings',
  'task_threads',
  'calls',
  'captures',
  'delegate_threads',
  'pages',
  'page_reviews',
  'page_threads',
  'computer_permissions',
  'computer_audit',
  'mcp_approvals',
  'mcp_actions',
  'usage_ledger',
  'action_log',
  'inbox_sources',
  'inbox_events',
  'discovery_findings',
  'push_devices',
  'channel_threads',
  'chat_approvals',
  'conv_threads',
  'conv_runs',
  'conv_events',
] as const;
const BATCH = 500;
/** Tables only the owner's own use fills; any rows mean it is not new. */
const OWNED = [
  'tasks',
  'memories',
  'thread_bindings',
  'conv_threads',
  'pages',
  'inbox_sources',
  'accounts',
];
/**
 * Tables that were renamed since the SQLite releases, and the columns that
 * were renamed with them. mcp_connections is not here: it becomes accounts
 * and grants, see importConnections.
 */
const RENAMED: Record<string, { to: string; columns: Record<string, string> }> =
  {
    mcp_approvals: {
      to: 'connector_approvals',
      columns: { connectionId: 'account_id' },
    },
    mcp_actions: {
      to: 'connector_actions',
      columns: { connectionId: 'account_id' },
    },
  };

const snake = (column: string) =>
  column.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

export interface ImportReport {
  table: string;
  rows: number;
  /** SQLite columns with no Postgres counterpart, such as retired features. */
  skipped: string[];
}

/**
 * Copies an existing OpenDots SQLite database (the old DATABASE_PATH) into
 * Postgres, once. Refuses to run when the Postgres database already holds
 * data, so it can never merge two histories. Rows keep their order, and
 * SQLite's 0/1 flags become booleans.
 */
export async function importSqlite(
  db: Db,
  path: string,
  /** Who the imported accounts belong to: the install's OWNER_ID. */
  userId = 'opendots-owner',
): Promise<ImportReport[]> {
  if (!existsSync(path)) throw new Error(`No SQLite file at ${path}.`);
  const source = new DatabaseSync(path, { readOnly: true });
  try {
    const present = new Set(
      source
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((row) => String(row.name)),
    );
    return await db.transaction(async () => {
      for (const table of OWNED)
        if (await db.row(sql`SELECT 1 FROM ${sql.raw(table)} LIMIT 1`))
          throw new Error(
            `The Postgres database already has data (${table}). Import into an empty database.`,
          );
      // Starting the app once seeds a Space, a Dot and settings; the
      // imported ones replace them.
      for (const table of ['settings', 'dot_spaces', 'dots', 'spaces'])
        await db.run(sql`DELETE FROM ${sql.raw(table)}`);
      const reports: ImportReport[] = [];
      for (const table of TABLES) {
        if (!present.has(table)) {
          // Before dot_spaces existed, a Dot could use only its own Space.
          if (table === 'dot_spaces' && present.has('dots')) {
            const rows = source
              .prepare('SELECT id, spaceId FROM dots ORDER BY rowid')
              .all();
            for (const row of rows)
              await db.run(
                sql`INSERT INTO dot_spaces VALUES (${String(row.id)}, ${String(row.spaceId)}) ON CONFLICT DO NOTHING`,
              );
            reports.push({ table, rows: rows.length, skipped: [] });
          }
          continue;
        }
        reports.push(await copyTable(db, source, table));
      }
      if (present.has('mcp_connections'))
        reports.push(await importConnections(db, source, userId));
      await db.exec(RETIRE_COMPOSIO_SOURCES);
      // Later task events continue after the imported ids.
      await db.exec(
        "SELECT setval(pg_get_serial_sequence('events', 'id'), GREATEST((SELECT MAX(id) FROM events), 1))",
      );
      return reports;
    });
  } finally {
    source.close();
  }
}

async function copyTable(
  db: Db,
  source: DatabaseSync,
  from: string,
): Promise<ImportReport> {
  const table = RENAMED[from]?.to ?? from;
  const renamed = RENAMED[from]?.columns ?? {};
  const target = new Map(
    (
      await db.rows<{
        columnName: string;
        dataType: string;
        generated: string;
      }>(
        sql`SELECT column_name, data_type, is_identity AS generated FROM information_schema.columns WHERE table_name=${table} AND table_schema=current_schema()`,
      )
    ).map((column) => [column.columnName, column]),
  );
  const sourceColumns = source
    .prepare(`PRAGMA table_info(${from})`)
    .all()
    .map((column) => String(column.name));
  const columns: { from: string; to: string; type: string }[] = [];
  const skipped: string[] = [];
  for (const name of sourceColumns) {
    const column = target.get(renamed[name] ?? snake(name));
    // seq columns are generated in insertion order; rows are read in rowid order.
    if (!column || column.columnName === 'seq') skipped.push(name);
    else
      columns.push({
        from: name,
        to: column.columnName,
        type: column.dataType,
      });
  }
  const rows = source
    .prepare(
      `SELECT ${columns.map((c) => `"${c.from}"`).join(', ')} FROM ${from} ORDER BY rowid`,
    )
    .all();
  const convert = (value: unknown, type: string) => {
    if (value === null || value === undefined) return null;
    if (type === 'boolean') return !!Number(value);
    if (type === 'bigint' || type === 'integer' || type === 'double precision')
      return Number(value);
    return String(value);
  };
  const list = sql.raw(columns.map((c) => c.to).join(', '));
  for (let start = 0; start < rows.length; start += BATCH) {
    const values = rows.slice(start, start + BATCH).map(
      (row) =>
        sql`(${sql.join(
          columns.map((c) => sql`${convert(row[c.from], c.type)}`),
          ', ',
        )})`,
    );
    await db.run(
      sql`INSERT INTO ${sql.raw(table)} (${list}) VALUES ${sql.join(values, ', ')} ON CONFLICT DO NOTHING`,
    );
  }
  return { table: from, rows: rows.length, skipped };
}

/**
 * Turns the SQLite releases' per-Dot connections into accounts and grants,
 * as migration 9 does for a Postgres database: connections to the same
 * endpoint with the same token are one account, shared by the Dots that had
 * it, and each tool's enabled and approval flags become a policy.
 */
async function importConnections(
  db: Db,
  source: DatabaseSync,
  userId: string,
): Promise<ImportReport> {
  const rows = source
    .prepare(
      'SELECT id, dotId, name, url, token, tools, error, createdAt, updatedAt FROM mcp_connections ORDER BY rowid',
    )
    .all();
  const text = (value: unknown) =>
    value === null || value === undefined ? null : String(value);
  const accounts = new Map<string, string>();
  const granted = new Set<string>();
  for (const row of rows) {
    const id = String(row.id);
    const dotId = String(row.dotId);
    const key = `${String(row.url)}\u0000${String(row.token ?? '')}`;
    const tools = JSON.parse(String(row.tools)) as Record<string, unknown>[];
    let accountId = accounts.get(key);
    if (!accountId) {
      accountId = id;
      accounts.set(key, id);
      // The catalog keeps what the service said; permissions become policies.
      const catalog = tools.map((tool) =>
        Object.fromEntries(
          Object.entries(tool).filter(
            ([key]) => key !== 'enabled' && key !== 'requiresApproval',
          ),
        ),
      );
      await db.run(
        sql`INSERT INTO accounts (id, user_id, connector, name, config, secret, tools, error, created_at, updated_at) VALUES (${id}, ${userId}, 'mcp', ${String(row.name)}, ${JSON.stringify({ url: String(row.url) })}, ${text(row.token)}, ${JSON.stringify(catalog)}, ${text(row.error)}, ${Number(row.createdAt)}, ${Number(row.updatedAt)})`,
      );
    }
    if (!granted.has(`${accountId}\u0000${dotId}`)) {
      granted.add(`${accountId}\u0000${dotId}`);
      await db.run(
        sql`INSERT INTO grants (id, account_id, dot_id, created_at, updated_at) VALUES (${id}, ${accountId}, ${dotId}, ${Number(row.createdAt)}, ${Number(row.updatedAt)})`,
      );
      for (const tool of tools)
        await db.run(
          sql`INSERT INTO grant_policies (grant_id, tool, policy) VALUES (${id}, ${String(tool.name)}, ${tool.enabled === false ? 'block' : tool.requiresApproval === false ? 'allow' : 'ask'}) ON CONFLICT DO NOTHING`,
        );
    }
    // Whatever referred to the connection now refers to its account.
    await db.run(
      sql`UPDATE connector_approvals SET account_id=${accountId} WHERE account_id=${id}`,
    );
    await db.run(
      sql`UPDATE connector_actions SET account_id=${accountId}, dot_id=${dotId} WHERE account_id=${id}`,
    );
    await db.run(
      sql`UPDATE inbox_sources SET config=jsonb_set(config::jsonb - 'connectionId', '{accountId}', to_jsonb(${accountId}::text))::text WHERE type='mcp' AND config::jsonb->>'connectionId'=${id}`,
    );
  }
  return { table: 'mcp_connections', rows: rows.length, skipped: [] };
}
