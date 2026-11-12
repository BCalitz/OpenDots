import { Hono } from 'hono';
import { z } from 'zod';
import type { WorkspaceStore } from './workspace.js';
import { connectionInput, type ConnectionService } from './connections.js';
export function connectionRoutes(
  workspace: WorkspaceStore,
  connections: ConnectionService,
) {
  const app = new Hono();
  app.onError((error, c) =>
    c.json(
      {
        error:
          error instanceof z.ZodError
            ? (error.issues[0]?.message ?? 'Invalid connection request.')
            : error.message,
      },
      400,
    ),
  );
  const requireDot = async (id: string) => {
    if (!(await workspace.dot(id))) throw new Error('Dot not found.');
    return id;
  };
  const owned = async (id: string) => {
    const connection = await connections.store.get(id);
    if (!connection) throw new Error('Connection not found.');
    return connection;
  };
  app.get('/dots/:id/connections', async (c) =>
    c.json(await connections.store.list(await requireDot(c.req.param('id')))),
  );
  app.post('/dots/:id/connections', async (c) =>
    c.json(
      await connections.add(
        await requireDot(c.req.param('id')),
        connectionInput.parse(await c.req.json()),
      ),
      201,
    ),
  );
  app.post('/connections/:id/refresh', async (c) =>
    c.json(await connections.refresh((await owned(c.req.param('id'))).id)),
  );
  app.patch('/connections/:id/tools/:name', async (c) => {
    const patch = z
      .object({
        enabled: z.boolean().optional(),
        requiresApproval: z.boolean().optional(),
      })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await connections.setTool(
        (await owned(c.req.param('id'))).id,
        c.req.param('name'),
        patch,
      ),
    );
  });
  app.delete('/connections/:id', async (c) => {
    await connections.store.remove((await owned(c.req.param('id'))).id);
    return c.json({ ok: true });
  });
  return app;
}
