import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { WorkspaceStore } from '../workspace.js';
import type { ConnectorService } from './service.js';

const policy = z.enum(['allow', 'ask', 'block']);
const create = z
  .object({ connector: z.string().trim().min(1).max(40) })
  .passthrough();

/**
 * A user's connected accounts, and the grants that let a Dot use them.
 *
 * `userOf` says who is asking. Until sign-in exists it is the one configured
 * owner; when it does, this is the only place that changes: every account and
 * grant below is already read and written for that user and nobody else.
 */
export function connectorRoutes(
  workspace: WorkspaceStore,
  connectors: ConnectorService,
  userOf: (c: Context) => string = () => workspace.ownerId,
) {
  const app = new Hono();
  app.onError((error, c) =>
    c.json(
      {
        error:
          error instanceof z.ZodError
            ? (error.issues[0]?.message ?? 'Invalid request.')
            : error.message,
      },
      400,
    ),
  );
  const requireDot = async (id: string) => {
    if (!(await workspace.dot(id))) throw new Error('Dot not found.');
    return id;
  };
  app.get('/accounts', async (c) => c.json(await connectors.list(userOf(c))));
  app.post('/accounts', async (c) => {
    const { connector, ...input } = create.parse(await c.req.json());
    return c.json(await connectors.add(userOf(c), connector, input), 201);
  });
  app.post('/accounts/:id/refresh', async (c) =>
    c.json(await connectors.refresh(userOf(c), c.req.param('id'))),
  );
  app.delete('/accounts/:id', async (c) => {
    if (!(await connectors.remove(userOf(c), c.req.param('id'))))
      throw new Error('Account not found.');
    return c.json({ ok: true });
  });
  app.get('/dots/:id/grants', async (c) =>
    c.json(await connectors.grants(await requireDot(c.req.param('id')))),
  );
  app.put('/dots/:id/grants/:accountId', async (c) =>
    c.json(
      await connectors.grant(
        userOf(c),
        await requireDot(c.req.param('id')),
        c.req.param('accountId'),
      ),
    ),
  );
  app.delete('/dots/:id/grants/:accountId', async (c) => {
    if (
      !(await connectors.revoke(
        userOf(c),
        await requireDot(c.req.param('id')),
        c.req.param('accountId'),
      ))
    )
      throw new Error('This Dot does not use that account.');
    return c.json({ ok: true });
  });
  app.patch('/dots/:id/grants/:accountId/tools/:name', async (c) => {
    const body = z
      .object({ policy })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await connectors.setPolicy(
        userOf(c),
        await requireDot(c.req.param('id')),
        c.req.param('accountId'),
        c.req.param('name'),
        body.policy,
      ),
    );
  });
  return app;
}
