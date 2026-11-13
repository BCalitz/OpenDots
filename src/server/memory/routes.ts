import { Hono } from 'hono';
import { z } from 'zod';
import type { Platform } from '../platform.js';
import type { EntityKind } from './store.js';

const KINDS: EntityKind[] = [
  'person',
  'company',
  'project',
  'place',
  'name',
  'invoice',
  'order',
  'ticket',
];

/** The owner's entities: search, read, merge, and the daily lines. */
export function memoryRoutes(platform: Platform) {
  const app = new Hono();
  const memory = platform.workspace.inbox.memory;
  const owner = () => platform.workspace.ownerId;
  app.get('/memory/entities', async (c) => {
    const kind = c.req.query('kind');
    return c.json(
      await memory.search(owner(), {
        query: c.req.query('q')?.slice(0, 200),
        kind: KINDS.includes(kind as EntityKind)
          ? (kind as EntityKind)
          : undefined,
        limit: Number(c.req.query('limit')) || undefined,
      }),
    );
  });
  app.get('/memory/entities/:id', async (c) => {
    const entity = await memory.entity(owner(), c.req.param('id'));
    return entity ? c.json(entity) : c.json({ error: 'Not found.' }, 404);
  });
  /** The owner says this entity is the same thing as another. */
  app.post('/memory/entities/:id/merge', async (c) => {
    const body = z
      .object({ into: z.string().min(1).max(200) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success)
      return c.json({ error: 'Choose what to merge into.' }, 400);
    const merged = await memory.merge(
      owner(),
      c.req.param('id'),
      body.data.into,
    );
    return merged
      ? c.json(merged)
      : c.json({ error: 'Choose two different entities you have.' }, 404);
  });
  app.get('/memory/runs', async (c) => c.json(await memory.runs(owner())));
  return app;
}
