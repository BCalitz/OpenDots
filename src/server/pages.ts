import { randomUUID } from 'node:crypto';
import { sql, type Db } from './db/index.js';
import { z } from 'zod';
import {
  pageReviewSchema,
  pageReviewTool,
  type PageReviewDraft,
} from '../shared/page-review.js';
import { ToolCalls } from './engine/tool-calls.js';
export const pageInput = z
  .object({
    title: z.string().trim().min(1).max(160),
    content: z.string().max(100000).default(''),
    parentId: z.string().min(1).nullable().default(null),
  })
  .strict();
export const pagePatch = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    content: z.string().max(100000).optional(),
    parentId: z.string().min(1).nullable().optional(),
    expectedRevision: z.number().int().positive(),
  })
  .strict();
export interface Page {
  id: string;
  spaceId: string;
  parentId: string | null;
  title: string;
  content: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  sourceThreadId: string | null;
}
export type ReviewedPage = Page & {
  reviewDraft: PageReviewDraft | null;
};
export class PageError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}
const PAGE = sql.raw(
  'id, space_id, parent_id, title, content, revision, created_at, updated_at, source_thread_id',
);
export class Pages {
  private toolCalls: ToolCalls;
  constructor(
    private db: Db,
    private spaceExists: (id: string) => Promise<boolean>,
  ) {
    this.toolCalls = new ToolCalls(db);
  }
  async requireSpace(spaceId: string) {
    if (!(await this.spaceExists(spaceId)))
      throw new PageError('Space not found.', 404);
  }
  async exists(spaceId: string, id: string): Promise<boolean> {
    await this.requireSpace(spaceId);
    return !!(await this.db.row(
      sql`SELECT 1 FROM pages WHERE id=${id} AND space_id=${spaceId}`,
    ));
  }
  async list(spaceId: string): Promise<Page[]> {
    await this.requireSpace(spaceId);
    return this.db.rows<Page>(
      sql`SELECT ${PAGE} FROM pages WHERE space_id=${spaceId} ORDER BY created_at, id`,
    );
  }
  async get(spaceId: string, id: string): Promise<Page> {
    await this.requireSpace(spaceId);
    const row = await this.db.row<Page>(
      sql`SELECT ${PAGE} FROM pages WHERE id=${id} AND space_id=${spaceId}`,
    );
    if (!row) throw new PageError('Page not found in this Space.', 404);
    return row;
  }
  private async parent(spaceId: string, parentId: string | null, id?: string) {
    const seen = new Set([id]);
    let cursor = parentId;
    while (cursor) {
      if (seen.has(cursor))
        throw new PageError(
          'A page cannot be moved into itself or a descendant.',
        );
      seen.add(cursor);
      cursor = (await this.get(spaceId, cursor)).parentId;
    }
  }
  async create(
    spaceId: string,
    input: z.input<typeof pageInput>,
    sourceThreadId: string | null = null,
  ): Promise<Page> {
    await this.requireSpace(spaceId);
    const parsed = pageInput.safeParse(input);
    if (!parsed.success)
      throw new PageError(
        'Pages require a title up to 160 characters and content up to 100,000 characters.',
      );
    const data = parsed.data;
    return this.db.transaction(async () => {
      await this.parent(spaceId, data.parentId);
      const id = randomUUID(),
        now = Date.now();
      await this.db.run(
        sql`INSERT INTO pages (id, space_id, parent_id, title, content, revision, created_at, updated_at, source_thread_id) VALUES (${id}, ${spaceId}, ${data.parentId}, ${data.title}, ${data.content}, 1, ${now}, ${now}, ${sourceThreadId})`,
      );
      return this.get(spaceId, id);
    });
  }
  /**
   * Saves a reviewed draft once per tool call: a repeated save returns the
   * same page, and a repeat with a different draft or Space is refused.
   */
  async createReviewed(
    spaceId: string,
    input: Pick<PageReviewDraft, 'title' | 'content'>,
    threadId: string,
    toolCallId: string,
  ): Promise<ReviewedPage> {
    const draft = pageReviewSchema.parse({ ...input, spaceId });
    const once = await this.toolCalls.once<{
      pageId: string;
      spaceId: string;
      draft: PageReviewDraft | null;
    }>(
      {
        threadId,
        toolCallId,
        kind: 'page_review',
        tool: pageReviewTool.name,
      },
      async () => {
        const page = await this.create(
          spaceId,
          { title: draft.title, content: draft.content },
          threadId,
        );
        return { pageId: page.id, spaceId, draft };
      },
      { atomic: true },
    );
    if (once.ran) {
      const page = await this.get(spaceId, once.result.pageId);
      return { ...page, reviewDraft: draft };
    }
    const previous = once.result;
    if (!previous)
      throw new PageError('This review is already being saved.', 409);
    if (previous.spaceId !== spaceId)
      throw new PageError(
        'This review was already saved to another Space.',
        409,
      );
    const saved = previous.draft
      ? pageReviewSchema.parse(previous.draft)
      : null;
    if (
      saved &&
      (saved.title !== draft.title || saved.content !== draft.content)
    )
      throw new PageError(
        'This review was already saved with a different draft. Start a new review for the changed draft.',
        409,
      );
    const page = await this.get(spaceId, previous.pageId);
    return { ...page, reviewDraft: saved };
  }
  /** The saved review for a tool call, if any. */
  async reviewReceipt(threadId: string, toolCallId: string) {
    const found = await this.toolCalls.get<{
      pageId: string;
      spaceId: string;
      draft: PageReviewDraft | null;
    }>(threadId, toolCallId);
    if (found?.kind !== 'page_review' || !found.result) return null;
    const { pageId, spaceId, draft } = found.result;
    return {
      pageId,
      spaceId,
      draft: draft ? pageReviewSchema.parse(draft) : null,
    };
  }
  update(
    spaceId: string,
    id: string,
    input: z.input<typeof pagePatch>,
  ): Promise<Page> {
    const parsed = pagePatch.safeParse(input);
    if (!parsed.success)
      return Promise.reject(
        new PageError('A valid page patch and expectedRevision are required.'),
      );
    const data = parsed.data;
    return this.db.transaction(async () => {
      const page = await this.get(spaceId, id);
      if (page.revision !== data.expectedRevision)
        throw new PageError(
          'This page changed. Reload the latest revision before saving your draft.',
          409,
        );
      const parent =
        data.parentId === undefined ? page.parentId : data.parentId;
      await this.parent(spaceId, parent, id);
      await this.db.run(
        sql`UPDATE pages SET title=${data.title ?? page.title}, content=${data.content ?? page.content}, parent_id=${parent}, revision=revision+1, updated_at=${Date.now()} WHERE id=${id} AND revision=${data.expectedRevision}`,
      );
      return this.get(spaceId, id);
    });
  }
  async thread(pageId: string, dotId: string) {
    const row = await this.db.row<{ threadId: string; ready: boolean }>(
      sql`SELECT thread_id, ready FROM page_threads WHERE page_id=${pageId} AND dot_id=${dotId}`,
    );
    return row ? { threadId: row.threadId, ready: row.ready } : undefined;
  }
  reserveThread(pageId: string, dotId: string, threadId: string) {
    return this.db.transaction(async () => {
      await this.db.run(
        sql`INSERT INTO page_threads (page_id, dot_id, thread_id, ready, lease_until) VALUES (${pageId}, ${dotId}, ${threadId}, false, 0) ON CONFLICT DO NOTHING`,
      );
      const now = Date.now();
      return (
        (await this.db.run(
          sql`UPDATE page_threads SET lease_until=${now + 60000} WHERE page_id=${pageId} AND dot_id=${dotId} AND NOT ready AND lease_until<=${now}`,
        )) > 0
      );
    });
  }
  async finishThread(pageId: string, dotId: string) {
    await this.db.run(
      sql`UPDATE page_threads SET ready=true WHERE page_id=${pageId} AND dot_id=${dotId}`,
    );
  }
  async releaseThread(pageId: string, dotId: string) {
    await this.db.run(
      sql`UPDATE page_threads SET lease_until=0 WHERE page_id=${pageId} AND dot_id=${dotId} AND NOT ready`,
    );
  }
  async forThread(
    threadId: string,
    spaceId?: string,
  ): Promise<Page | undefined> {
    const row = await this.db.row<{ pageId: string; spaceId: string }>(
      sql`SELECT page_threads.page_id, pages.space_id FROM page_threads JOIN pages ON pages.id=page_threads.page_id WHERE page_threads.thread_id=${threadId} AND page_threads.ready`,
    );
    return row ? this.get(spaceId ?? row.spaceId, row.pageId) : undefined;
  }
  async delete(spaceId: string, id: string): Promise<boolean> {
    await this.requireSpace(spaceId);
    return this.db.transaction(async () => {
      const page = await this.db.row<{ parentId: string | null }>(
        sql`SELECT parent_id FROM pages WHERE id=${id} AND space_id=${spaceId}`,
      );
      if (!page) return false;
      const now = Date.now();
      await this.db.run(
        sql`UPDATE pages SET parent_id=${page.parentId}, revision=revision+1, updated_at=${now} WHERE space_id=${spaceId} AND parent_id=${id}`,
      );
      // Its tool_calls record stays: a retried approval must not recreate this page.
      await this.db.run(sql`DELETE FROM page_threads WHERE page_id=${id}`);
      await this.db.run(
        sql`DELETE FROM pages WHERE id=${id} AND space_id=${spaceId}`,
      );
      return true;
    });
  }
}
