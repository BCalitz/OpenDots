import { Hono } from 'hono';
import { z } from 'zod';
import type { Platform } from './platform.js';
import { inspectRun } from './conversations/inspect.js';
import type { RunDetail } from '../shared/insight-types.js';

const LOCAL_ONLY =
  'The run inspector reads conversations stored on this server. Set CONVERSATION_BACKEND=local to use it.';
const listQuery = z.object({
  dotId: z.string().max(200).optional(),
  threadId: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** Run inspector, cost meter and audit view (roadmap phase 2). */
export function insightRoutes(platform: Platform) {
  const app = new Hono();
  app.get('/runs', async (c) => {
    const runner = platform.runner;
    if (!runner) return c.json({ error: LOCAL_ONLY }, 422);
    const query = listQuery.safeParse(c.req.query());
    if (!query.success) return c.json({ error: 'Invalid run filter.' }, 400);
    return c.json(
      await runner.listRuns({
        agentId: query.data.dotId,
        threadId: query.data.threadId,
        limit: query.data.limit,
      }),
    );
  });
  app.get('/runs/:id', async (c) => {
    const runner = platform.runner;
    if (!runner) return c.json({ error: LOCAL_ONLY }, 422);
    const detail = await runner.runDetail(c.req.param('id'));
    if (!detail) return c.json({ error: 'Run not found.' }, 404);
    const body: RunDetail = {
      run: detail.run,
      threadName: detail.threadName,
      steps: inspectRun(detail.events),
    };
    return c.json(body);
  });
  app.get('/usage', async (c) => {
    const days = z.coerce
      .number()
      .int()
      .min(1)
      .max(366)
      .catch(30)
      .parse(c.req.query('days') ?? 30);
    return c.json(
      await platform.workspace.usage.report(
        await platform.workspace.dots(),
        days,
      ),
    );
  });
  app.get('/audit', async (c) => {
    const query = z
      .object({
        dotId: z.string().max(200).optional(),
        changes: z.enum(['0', '1']).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
      })
      .safeParse(c.req.query());
    if (!query.success) return c.json({ error: 'Invalid audit filter.' }, 400);
    return c.json(
      await platform.workspace.usage.audit({
        dotId: query.data.dotId,
        changesOnly: query.data.changes === '1',
        limit: query.data.limit,
      }),
    );
  });
  return app;
}
