import { ComputerStore } from './computer-store.js';
import { AccountStore } from './connectors/accounts.js';
import { ActionStore } from './connectors/actions.js';
import { Pages } from './pages.js';
import { UsageStore } from './usage-store.js';
import { InboxStore } from './inbox/store.js';
import { randomUUID } from 'node:crypto';
import { sql, type Db } from './db/index.js';
import type { CallReceipt, Conversation, Dot, Space } from '../shared/types.js';

type DotRow = Omit<Dot, 'spaceIds' | 'composioToolkits' | 'delegateDotIds'> & {
  composioToolkits: string;
  delegateDotIds: string;
};
const DOT = sql.raw(
  'id, space_id, name, instructions, research_allowed, memory_allowed, created_at, apps_allowed, composio_toolkits, composio_session_id, composio_policy_hash, monthly_token_cap, delegate_dot_ids',
);
const CALL = sql.raw(
  'id, thread_id, started_at, ended_at, status, transcript, error, anchor_message_id',
);
const BINDING = sql.raw(
  'id, dot_id, owner_id, title, created_at, source, parent_id, anchor_message_id',
);
type BindingRow = Omit<
  Conversation,
  'source' | 'parentId' | 'anchorMessageId'
> & {
  source: string | null;
  parentId: string | null;
  anchorMessageId: string | null;
};
function fromBinding({
  source,
  parentId,
  anchorMessageId,
  ...row
}: BindingRow): Conversation {
  return {
    ...row,
    ...(source ? { source } : {}),
    ...(parentId ? { parentId } : {}),
    ...(anchorMessageId ? { anchorMessageId } : {}),
  };
}

export class WorkspaceStore {
  readonly pages: Pages;
  readonly computers: ComputerStore;
  readonly accounts: AccountStore;
  readonly actions: ActionStore;
  readonly usage: UsageStore;
  readonly inbox: InboxStore;
  /** A workspace with at least one Space and Dot. */
  static async open(db: Db, ownerId: string) {
    const workspace = new WorkspaceStore(db, ownerId);
    await workspace.seed();
    return workspace;
  }
  constructor(
    readonly db: Db,
    readonly ownerId: string,
  ) {
    this.computers = new ComputerStore(db);
    this.accounts = new AccountStore(db);
    this.actions = new ActionStore(db);
    this.usage = new UsageStore(db);
    this.inbox = new InboxStore(db);
    this.pages = new Pages(db, (id) => this.spaceExists(id));
  }
  /** Creates the first Space and Dot on a new install. */
  async seed() {
    await this.db.transaction(async () => {
      if ((await this.spaces()).length) return;
      const space = await this.createSpace(
        'Everyday',
        'A little space for your day.',
      );
      await this.createDot(
        space.id,
        'Dot',
        'Be thoughtful, practical, and concise. Help the user think clearly and follow through.',
        true,
        true,
      );
    });
  }
  spaces(): Promise<Space[]> {
    return this.db.rows<Space>(
      sql`SELECT id, name, description, created_at FROM spaces ORDER BY created_at`,
    );
  }
  async spaceExists(id: string) {
    return !!(await this.db.row(sql`SELECT 1 FROM spaces WHERE id=${id}`));
  }
  async createSpace(name: string, description: string): Promise<Space> {
    const space = {
      id: randomUUID(),
      name,
      description,
      createdAt: Date.now(),
    };
    await this.db.run(
      sql`INSERT INTO spaces VALUES (${space.id}, ${name}, ${description}, ${space.createdAt})`,
    );
    return space;
  }
  async dots(): Promise<Dot[]> {
    const [rows, grants] = await Promise.all([
      this.db.rows<DotRow>(sql`SELECT ${DOT} FROM dots ORDER BY created_at`),
      this.db.rows<{ dotId: string; spaceId: string }>(
        sql`SELECT dot_id, space_id FROM dot_spaces ORDER BY space_id`,
      ),
    ]);
    return rows.map((row) => ({
      ...row,
      spaceIds: grants
        .filter((grant) => grant.dotId === row.id)
        .map((grant) => grant.spaceId),
      composioToolkits: JSON.parse(row.composioToolkits ?? '[]'),
      monthlyTokenCap: row.monthlyTokenCap ?? null,
      delegateDotIds: JSON.parse(row.delegateDotIds ?? '[]'),
    }));
  }
  async dot(id: string) {
    return (await this.dots()).find((dot) => dot.id === id);
  }
  async createDot(
    spaceId: string,
    name: string,
    instructions: string,
    researchAllowed: boolean,
    memoryAllowed: boolean,
    spaceIds: string[] = [spaceId],
    appsAllowed = false,
    composioToolkits: string[] = [],
  ): Promise<Dot> {
    await this.validateSpaceAccess(spaceId, spaceIds);
    const dot: Dot = {
      id: randomUUID(),
      spaceId,
      spaceIds: [...new Set(spaceIds)].sort(),
      name,
      instructions,
      researchAllowed,
      memoryAllowed,
      appsAllowed,
      composioToolkits: [...new Set(composioToolkits)].sort(),
      composioSessionId: null,
      composioPolicyHash: null,
      createdAt: Date.now(),
    };
    await this.db.transaction(async () => {
      await this.db.run(
        sql`INSERT INTO dots (id, space_id, name, instructions, research_allowed, memory_allowed, created_at, apps_allowed, composio_toolkits) VALUES (${dot.id}, ${spaceId}, ${name}, ${instructions}, ${researchAllowed}, ${memoryAllowed}, ${dot.createdAt}, ${appsAllowed}, ${JSON.stringify(dot.composioToolkits)})`,
      );
      for (const id of dot.spaceIds)
        await this.db.run(
          sql`INSERT INTO dot_spaces VALUES (${dot.id}, ${id})`,
        );
    });
    return dot;
  }
  async canAccessSpace(dotId: string, spaceId: string) {
    return !!(await this.db.row(
      sql`SELECT 1 FROM dot_spaces WHERE dot_id=${dotId} AND space_id=${spaceId}`,
    ));
  }
  private async validateSpaceAccess(defaultSpace: string, spaceIds: string[]) {
    const spaces = await this.spaces();
    if (
      !spaceIds.includes(defaultSpace) ||
      spaceIds.some((id) => !spaces.some((space) => space.id === id))
    )
      throw new Error('Space access must include a valid default destination.');
  }
  async updateDot(
    id: string,
    patch: Pick<
      Dot,
      | 'name'
      | 'instructions'
      | 'researchAllowed'
      | 'memoryAllowed'
      | 'appsAllowed'
      | 'composioToolkits'
    > & {
      spaceId?: string;
      spaceIds?: string[];
    },
  ): Promise<Dot> {
    return this.db.transaction(async () => {
      const current = await this.dot(id);
      if (!current) throw new Error('Dot not found.');
      const defaultSpace = patch.spaceId ?? current.spaceId;
      const spaceIds = patch.spaceIds ?? current.spaceIds;
      await this.validateSpaceAccess(defaultSpace, spaceIds);
      await this.db.run(
        sql`UPDATE dots SET name=${patch.name}, instructions=${patch.instructions}, research_allowed=${patch.researchAllowed}, memory_allowed=${patch.memoryAllowed}, apps_allowed=${patch.appsAllowed}, composio_toolkits=${JSON.stringify([...new Set(patch.composioToolkits)].sort())}, space_id=${defaultSpace} WHERE id=${id}`,
      );
      await this.db.run(sql`DELETE FROM dot_spaces WHERE dot_id=${id}`);
      for (const space of new Set(spaceIds))
        await this.db.run(sql`INSERT INTO dot_spaces VALUES (${id}, ${space})`);
      return (await this.dot(id))!;
    });
  }
  /** Tokens per UTC month before the Dot stops starting new turns; null removes it. */
  async setMonthlyTokenCap(id: string, cap: number | null) {
    if (!(await this.dot(id))) throw new Error('Dot not found.');
    await this.db.run(
      sql`UPDATE dots SET monthly_token_cap=${cap} WHERE id=${id}`,
    );
    return (await this.dot(id))!;
  }
  /** Which other Dots this one may direct. */
  async setDelegates(id: string, dotIds: string[]) {
    const dots = await this.dots();
    if (!dots.some((dot) => dot.id === id)) throw new Error('Dot not found.');
    const unique = [...new Set(dotIds)];
    if (unique.includes(id)) throw new Error('Dot cannot direct itself.');
    if (unique.some((other) => !dots.some((dot) => dot.id === other)))
      throw new Error('Dot not found.');
    await this.db.run(
      sql`UPDATE dots SET delegate_dot_ids=${JSON.stringify(unique.sort())} WHERE id=${id}`,
    );
    return (await this.dot(id))!;
  }
  /** The thread a Dot uses for requests from one coordinator conversation. */
  async delegateThread(parentThreadId: string, dotId: string) {
    return (
      await this.db.row<{ threadId: string }>(
        sql`SELECT thread_id FROM delegate_threads WHERE parent_thread_id=${parentThreadId} AND dot_id=${dotId}`,
      )
    )?.threadId;
  }
  async bindDelegate(parentThreadId: string, dotId: string, threadId: string) {
    await this.db.run(
      sql`INSERT INTO delegate_threads VALUES (${parentThreadId}, ${dotId}, ${threadId})`,
    );
  }
  /** True for threads that exist to answer another Dot. */
  async isDelegateThread(threadId: string) {
    return !!(await this.db.row(
      sql`SELECT 1 FROM delegate_threads WHERE thread_id=${threadId}`,
    ));
  }
  async saveComposioSession(id: string, sessionId: string, policyHash: string) {
    await this.db.run(
      sql`UPDATE dots SET composio_session_id=${sessionId}, composio_policy_hash=${policyHash} WHERE id=${id}`,
    );
  }
  async conversations(): Promise<Conversation[]> {
    const rows = await this.db.rows<BindingRow>(
      sql`SELECT ${BINDING} FROM thread_bindings WHERE owner_id=${this.ownerId} ORDER BY created_at DESC`,
    );
    return rows.map(fromBinding);
  }
  /** One of the owner's conversations, if it exists. */
  async conversation(id: string): Promise<Conversation | undefined> {
    const row = await this.db.row<BindingRow>(
      sql`SELECT ${BINDING} FROM thread_bindings WHERE id=${id} AND owner_id=${this.ownerId}`,
    );
    return row && fromBinding(row);
  }
  /** Topic threads in a Dot's main chat, newest first. */
  async topicThreads(parentId: string): Promise<Conversation[]> {
    const rows = await this.db.rows<BindingRow>(
      sql`SELECT ${BINDING} FROM thread_bindings WHERE parent_id=${parentId} AND owner_id=${this.ownerId} ORDER BY created_at DESC`,
    );
    return rows.map(fromBinding);
  }
  /**
   * Each Dot is one continuing chat. Its main conversation is the latest
   * thread that is not answering another Dot or mirroring Slack.
   */
  async mainConversation(dotId: string): Promise<Conversation | undefined> {
    return (await this.mainConversationList()).get(dotId);
  }
  /** Main conversation id for every Dot that has one. */
  async mainConversations(): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    const main = await this.mainConversationList();
    for (const dot of await this.dots()) {
      const thread = main.get(dot.id);
      if (thread) result[dot.id] = thread.id;
    }
    return result;
  }
  private async mainConversationList() {
    const delegates = new Set(
      (
        await this.db.rows<{ threadId: string }>(
          sql`SELECT thread_id FROM delegate_threads`,
        )
      ).map((row) => row.threadId),
    );
    const main = new Map<string, Conversation>();
    for (const thread of await this.conversations())
      if (
        !main.has(thread.dotId) &&
        !thread.source &&
        !thread.parentId &&
        // Slack threads from before threads recorded their source.
        thread.title !== 'Slack conversation' &&
        !delegates.has(thread.id)
      )
        main.set(thread.dotId, thread);
    return main;
  }
  /**
   * `source` marks a background thread, such as one mirroring Slack;
   * `parentId` makes it a topic thread in that main chat.
   */
  async bindThread(
    id: string,
    dotId: string,
    title: string,
    source?: string,
    topic?: { parentId: string; anchorMessageId?: string },
  ): Promise<Conversation> {
    if (!(await this.dot(dotId))) throw new Error('Dot not found.');
    const value: Conversation = {
      id,
      dotId,
      ownerId: this.ownerId,
      title,
      createdAt: Date.now(),
      ...(source ? { source } : {}),
      ...(topic?.parentId ? { parentId: topic.parentId } : {}),
      ...(topic?.anchorMessageId
        ? { anchorMessageId: topic.anchorMessageId }
        : {}),
    };
    await this.db.run(
      sql`INSERT INTO thread_bindings (id, dot_id, owner_id, title, created_at, source, parent_id, anchor_message_id) VALUES (${id}, ${dotId}, ${this.ownerId}, ${title}, ${value.createdAt}, ${source ?? null}, ${topic?.parentId ?? null}, ${topic?.anchorMessageId ?? null})`,
    );
    return value;
  }
  /** Removes a topic thread's binding, e.g. after undoing an automatic move. */
  async unbindTopic(id: string) {
    await this.db.run(
      sql`DELETE FROM thread_bindings WHERE id=${id} AND owner_id=${this.ownerId} AND parent_id IS NOT NULL`,
    );
  }
  async retitleThread(id: string, title: string) {
    await this.db.run(
      sql`UPDATE thread_bindings SET title=${title} WHERE id=${id} AND owner_id=${this.ownerId}`,
    );
  }
  async requireThread(id: string, dotId?: string): Promise<Conversation> {
    const thread = await this.conversation(id);
    if (!thread || (dotId && thread.dotId !== dotId))
      throw new Error('Conversation does not belong to this Dot and owner.');
    return thread;
  }
  async bindTask(taskId: string, threadId: string) {
    await this.requireThread(threadId);
    await this.db.run(
      sql`INSERT INTO task_threads VALUES (${taskId}, ${threadId})`,
    );
  }
  async taskThread(taskId: string): Promise<string | undefined> {
    return (
      await this.db.row<{ threadId: string }>(
        sql`SELECT thread_id FROM task_threads WHERE task_id=${taskId}`,
      )
    )?.threadId;
  }
  async calls(threadId?: string): Promise<CallReceipt[]> {
    if (threadId) await this.requireThread(threadId);
    return this.db.rows<CallReceipt>(
      sql`SELECT ${CALL} FROM calls ${threadId ? sql`WHERE thread_id=${threadId}` : sql``} ORDER BY started_at DESC`,
    );
  }
  async createCall(threadId: string): Promise<CallReceipt> {
    await this.requireThread(threadId);
    const call: CallReceipt = {
      id: randomUUID(),
      threadId,
      startedAt: Date.now(),
      endedAt: null,
      status: 'connecting',
      transcript: '',
      error: null,
    };
    await this.db.run(
      sql`INSERT INTO calls (id, thread_id, started_at, ended_at, status, transcript, error) VALUES (${call.id}, ${threadId}, ${call.startedAt}, NULL, ${call.status}, '', NULL)`,
    );
    return call;
  }
  async call(id: string): Promise<CallReceipt> {
    const call = await this.db.row<CallReceipt>(
      sql`SELECT ${CALL} FROM calls WHERE id=${id}`,
    );
    if (!call) throw new Error('Call not found.');
    await this.requireThread(call.threadId);
    return call;
  }
  async setCall(
    id: string,
    status: CallReceipt['status'],
    transcript: string,
    error: string | null = null,
  ) {
    const call = await this.call(id);
    if (call.endedAt) return call;
    await this.db.run(
      sql`UPDATE calls SET status=${status}, transcript=${transcript}, error=${error}, ended_at=${status === 'ended' || status === 'failed' ? Date.now() : null} WHERE id=${id} AND ended_at IS NULL`,
    );
    return this.call(id);
  }
  async saveLateTranscript(id: string, transcript: string) {
    await this.call(id);
    return (
      (await this.db.run(
        sql`UPDATE calls SET transcript=${transcript} WHERE id=${id} AND transcript='' AND ended_at IS NOT NULL`,
      )) > 0
    );
  }
  async anchorCall(id: string, anchor: string | undefined) {
    await this.call(id);
    await this.db.run(
      sql`UPDATE calls SET anchor_message_id=${anchor ?? null} WHERE id=${id}`,
    );
  }
  async setCallError(id: string, error: string | null) {
    await this.call(id);
    await this.db.run(sql`UPDATE calls SET error=${error} WHERE id=${id}`);
  }
  async saveCapture(threadId: string, value: unknown) {
    await this.requireThread(threadId);
    await this.db.run(
      sql`INSERT INTO captures VALUES (${threadId}, ${JSON.stringify(value)}) ON CONFLICT (thread_id) DO UPDATE SET value=excluded.value`,
    );
  }
  async capture(threadId: string): Promise<unknown> {
    await this.requireThread(threadId);
    const row = await this.db.row<{ value: string }>(
      sql`SELECT value FROM captures WHERE thread_id=${threadId}`,
    );
    return row ? JSON.parse(row.value) : null;
  }
}
