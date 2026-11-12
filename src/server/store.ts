import { randomUUID } from 'node:crypto';
import { sql, type Db } from './db/index.js';
import type {
  Action,
  Detail,
  Memory,
  Result,
  Run,
  Settings,
  Task,
  TaskEvent,
} from '../shared/types.js';

export type Claim = Task & { lease: string };
export const DEFAULT_WORKER_LEASE_MS = 180_000;
const defaults: Settings = {
  name: 'Dot',
  paused: false,
  researchAllowed: true,
  memoryAllowed: true,
  appsAllowed: false,
};
const TASK = sql.raw(
  'id, prompt, status, interval_seconds, next_run_at, created_at, updated_at, error, lease, lease_until',
);
export class Store {
  constructor(readonly db: Db) {}
  async setupTelemetryState(): Promise<string | undefined> {
    return (
      await this.db.row<{ value: string }>(
        sql`SELECT value FROM setup_telemetry WHERE id=1`,
      )
    )?.value;
  }
  async saveSetupTelemetryState(value: string) {
    await this.db.run(
      sql`INSERT INTO setup_telemetry VALUES (1, ${value}) ON CONFLICT (id) DO UPDATE SET value=excluded.value`,
    );
  }
  async clearSetupTelemetry() {
    await this.db.run(sql`DELETE FROM setup_telemetry`);
  }
  private transaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.db.transaction(fn);
  }
  async settings(): Promise<Settings> {
    const row = await this.db.row<{ value: string }>(
      sql`SELECT value FROM settings WHERE id=1`,
    );
    return {
      ...defaults,
      ...(row ? (JSON.parse(row.value) as Partial<Settings>) : {}),
    };
  }
  updateSettings(patch: Partial<Settings>): Promise<Settings> {
    return this.transaction(async () => {
      const previous = await this.settings();
      const settings = { ...previous, ...patch };
      await this.db.run(
        sql`INSERT INTO settings VALUES (1, ${JSON.stringify(settings)}) ON CONFLICT (id) DO UPDATE SET value=excluded.value`,
      );
      if (
        (!previous.paused && settings.paused) ||
        (previous.researchAllowed && !settings.researchAllowed) ||
        (previous.memoryAllowed && !settings.memoryAllowed) ||
        (previous.appsAllowed && !settings.appsAllowed)
      ) {
        const running = (await this.tasks()).filter(
          (t) => t.status === 'running',
        );
        for (const task of running) {
          await this.invalidate(
            task,
            'interrupted',
            'Run interrupted because settings changed. Review completed effects before retrying.',
          );
        }
      }
      return settings;
    });
  }
  tasks(): Promise<Task[]> {
    return this.db.rows<Task>(
      sql`SELECT ${TASK} FROM tasks ORDER BY created_at DESC`,
    );
  }
  task(id: string): Promise<Task | undefined> {
    return this.db.row<Task>(sql`SELECT ${TASK} FROM tasks WHERE id=${id}`);
  }
  async createTask(
    prompt: string,
    intervalSeconds: number | null = null,
  ): Promise<Task> {
    const now = Date.now();
    const id = randomUUID();
    await this.db.run(
      sql`INSERT INTO tasks (id, prompt, status, interval_seconds, created_at, updated_at) VALUES (${id}, ${prompt}, 'queued', ${intervalSeconds}, ${now}, ${now})`,
    );
    await this.event(id, null, 'Task added to the queue.');
    return (await this.task(id))!;
  }
  async detail(id: string): Promise<Detail | undefined> {
    const task = await this.task(id);
    if (!task) return undefined;
    const rows = await this.db.rows<
      Omit<Run, 'result'> & { result: string | null }
    >(
      sql`SELECT id, task_id, status, started_at, finished_at, result, error FROM runs WHERE task_id=${id} ORDER BY started_at DESC, seq DESC`,
    );
    return {
      task,
      runs: rows.map((row) => ({
        ...row,
        result: row.result ? (JSON.parse(row.result) as Result) : null,
      })),
      events: await this.db.rows<TaskEvent>(
        sql`SELECT * FROM events WHERE task_id=${id} ORDER BY id`,
      ),
    };
  }
  async event(taskId: string, runId: string | null, text: string) {
    await this.db.run(
      sql`INSERT INTO events (task_id, run_id, text, created_at) VALUES (${taskId}, ${runId}, ${text}, ${Date.now()})`,
    );
  }
  private async invalidate(task: Task, status: string, reason: string) {
    const now = Date.now();
    if (task.lease)
      await this.db.run(
        sql`UPDATE runs SET status='interrupted', finished_at=${now}, error=${reason} WHERE id=${task.lease} AND status='running'`,
      );
    await this.db.run(
      sql`UPDATE tasks SET status=${status}, lease=NULL, lease_until=NULL, updated_at=${now}, error=${status === 'interrupted' ? reason : null} WHERE id=${task.id}`,
    );
    await this.event(task.id, task.lease, reason);
  }
  action(id: string, action: Action): Promise<Task | undefined> {
    return this.transaction(async () => {
      const task = await this.task(id);
      if (!task) return undefined;
      if (action === 'run' && task.status === 'running') return task;
      const status =
        action === 'run'
          ? 'queued'
          : action === 'pause'
            ? 'paused'
            : 'cancelled';
      await this.invalidate(
        task,
        status,
        action === 'run' ? 'Task queued for a new run.' : `Task ${status}.`,
      );
      await this.db.run(
        sql`UPDATE tasks SET error=NULL, next_run_at=NULL WHERE id=${id}`,
      );
      return this.task(id);
    });
  }
  schedule(
    id: string,
    intervalSeconds: number | null,
  ): Promise<Task | undefined> {
    return this.transaction(async () => {
      const task = await this.task(id);
      if (!task) return undefined;
      const next =
        intervalSeconds && task.status === 'completed'
          ? Date.now() + intervalSeconds * 1000
          : null;
      await this.db.run(
        sql`UPDATE tasks SET interval_seconds=${intervalSeconds}, next_run_at=${next}, updated_at=${Date.now()} WHERE id=${id}`,
      );
      await this.event(
        id,
        null,
        intervalSeconds
          ? `Repeats every ${intervalSeconds / 60} minutes after a successful run.`
          : 'Repeat schedule removed.',
      );
      return this.task(id);
    });
  }
  claim(
    now = Date.now(),
    leaseDurationMs = DEFAULT_WORKER_LEASE_MS,
  ): Promise<Claim | null> {
    return this.transaction(async () => {
      const settings = await this.settings();
      if (settings.paused || !settings.researchAllowed) return null;
      const expired = await this.db.rows<Task>(
        sql`SELECT ${TASK} FROM tasks WHERE status='running' AND lease_until<=${now}`,
      );
      for (const task of expired)
        await this.invalidate(
          task,
          'interrupted',
          'Worker lease expired. Review completed effects before retrying.',
        );
      const task = await this.db.row<Task>(
        sql`SELECT ${TASK} FROM tasks WHERE status='queued' OR (status='completed' AND next_run_at IS NOT NULL AND next_run_at<=${now}) ORDER BY created_at LIMIT 1`,
      );
      if (!task) return null;
      const lease = randomUUID();
      await this.db.run(
        sql`UPDATE tasks SET status='running', lease=${lease}, lease_until=${now + leaseDurationMs}, next_run_at=NULL, error=NULL, updated_at=${now} WHERE id=${task.id}`,
      );
      await this.db.run(
        sql`INSERT INTO runs (id, task_id, status, started_at) VALUES (${lease}, ${task.id}, 'running', ${now})`,
      );
      await this.event(task.id, lease, 'Run started.');
      return { ...(await this.task(task.id))!, lease };
    });
  }
  async owns(claim: Claim): Promise<boolean> {
    const task = await this.task(claim.id);
    return task?.status === 'running' && task.lease === claim.lease;
  }
  finish(claim: Claim, result: Result, now = Date.now()): Promise<boolean> {
    return this.transaction(async () => {
      if (!(await this.owns(claim))) return false;
      const task = (await this.task(claim.id))!;
      await this.db.run(
        sql`UPDATE runs SET status='completed', finished_at=${now}, result=${JSON.stringify(result)} WHERE id=${claim.lease}`,
      );
      await this.db.run(
        sql`UPDATE tasks SET status='completed', lease=NULL, lease_until=NULL, updated_at=${now}, next_run_at=${task.intervalSeconds ? now + task.intervalSeconds * 1000 : null} WHERE id=${claim.id}`,
      );
      await this.event(
        claim.id,
        claim.lease,
        result.sample ? 'Fictional sample brief ready.' : 'Run completed.',
      );
      return true;
    });
  }
  async interrupt(claim: Claim, reason: string) {
    await this.transaction(async () => {
      if (await this.owns(claim))
        await this.invalidate(claim, 'interrupted', reason);
    });
  }
  async fail(claim: Claim, error: string) {
    await this.transaction(async () => {
      if (!(await this.owns(claim))) return;
      const now = Date.now();
      await this.db.run(
        sql`UPDATE runs SET status='failed', finished_at=${now}, error=${error} WHERE id=${claim.lease}`,
      );
      await this.db.run(
        sql`UPDATE tasks SET status='failed', lease=NULL, lease_until=NULL, error=${error}, updated_at=${now} WHERE id=${claim.id}`,
      );
      await this.event(claim.id, claim.lease, error);
    });
  }
  memories(): Promise<Memory[]> {
    return this.db.rows<Memory>(
      sql`SELECT * FROM memories ORDER BY created_at DESC`,
    );
  }
  async saveMemory(text: string, id: string = randomUUID()): Promise<Memory> {
    return (await this.db.row<Memory>(
      sql`INSERT INTO memories VALUES (${id}, ${text}, ${Date.now()}) ON CONFLICT (id) DO UPDATE SET text=excluded.text RETURNING *`,
    ))!;
  }
  async deleteMemory(id: string): Promise<boolean> {
    return (await this.db.run(sql`DELETE FROM memories WHERE id=${id}`)) > 0;
  }
}
