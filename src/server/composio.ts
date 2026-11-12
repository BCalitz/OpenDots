import { createHash } from 'node:crypto';
import { Composio } from '@composio/core';
import type { Dot } from '../shared/types.js';
import type { ComposioExecute } from './inbox/composio-source.js';
import type { PlatformConfig } from './platform-config.js';
import type { WorkspaceStore } from './workspace.js';

let client: Composio | undefined;
let clientKey: string | undefined;

export function composioClient(apiKey: string) {
  if (!client || clientKey !== apiKey) {
    client = new Composio({ apiKey });
    clientKey = apiKey;
  }
  return client;
}

type ComposioSession = Awaited<ReturnType<Composio['sessions']['create']>>;
/** Read-only sessions are kept in memory, apart from the Dot's own session. */
const readOnlySessions = new Map<string, Promise<ComposioSession>>();
/**
 * Composio's own filter for tools that only read: tools tagged readOnlyHint,
 * no remote workbench, no new sign-ins.
 */
const READ_ONLY = {
  tags: { enable: ['readOnlyHint' as const] },
  workbench: { enable: false },
  manageConnections: false,
};

export async function composioSession(
  config: PlatformConfig,
  workspace: WorkspaceStore,
  dot: Dot,
  ownerId: string,
  signal?: AbortSignal,
  options: { readOnly?: boolean } = {},
) {
  if (!config.composioApiKey) throw new Error('Composio is not configured.');
  const toolkits = [...new Set(dot.composioToolkits)].sort();
  const policy = { toolkits, instant: false as const };
  const policyHash = createHash('sha256')
    .update(JSON.stringify(policy))
    .digest('hex');
  const composio = composioClient(config.composioApiKey);
  if (options.readOnly) {
    const key = `${config.composioApiKey}:${ownerId}:${policyHash}`;
    let session = readOnlySessions.get(key);
    if (!session) {
      session = composio.sessions.create(
        ownerId,
        {
          ...(toolkits.length ? { toolkits } : {}),
          instant: false,
          ...READ_ONLY,
        },
        { signal },
      );
      readOnlySessions.set(key, session);
      session.catch(() => readOnlySessions.delete(key));
    }
    return session;
  }
  if (dot.composioSessionId && dot.composioPolicyHash === policyHash)
    return composio.sessions.use(dot.composioSessionId, undefined, { signal });
  const session = await composio.sessions.create(
    ownerId,
    {
      ...(toolkits.length ? { toolkits } : {}),
      manageConnections: true,
      instant: false,
    },
    { signal },
  );
  await workspace.saveComposioSession(dot.id, session.sessionId, policyHash);
  return session;
}

const readOnlyCache = new Map<string, Promise<boolean>>();
/**
 * Whether Composio marks a tool as one that only reads. Unknown tools and
 * failed lookups count as not read-only.
 */
export function isReadOnlyTool(composio: Composio, slug: string) {
  const key = slug.toUpperCase();
  let known = readOnlyCache.get(key);
  if (!known) {
    known = composio.tools
      .getRawComposioToolBySlug(key)
      .then((tool) => {
        const tags = (tool.tags ?? []).map((tag) => String(tag));
        return (
          tags.includes('readOnlyHint') && !tags.includes('destructiveHint')
        );
      })
      .catch(() => {
        readOnlyCache.delete(key);
        return false;
      });
    readOnlyCache.set(key, known);
  }
  return known;
}

/**
 * Runs read-only tools on one connected account, for discovery sources.
 * Each account gets its own read-only session, and every tool is checked
 * again before it runs.
 */
export function composioReader(
  apiKey: string,
  ownerId: string,
): ComposioExecute {
  const composio = composioClient(apiKey);
  const sessions = new Map<string, Promise<ComposioSession>>();
  return async (call, signal) => {
    if (!(await isReadOnlyTool(composio, call.tool)))
      throw new Error(`${call.tool} is not a read-only tool.`);
    const key = `${call.toolkit}:${call.accountId}`;
    let pending = sessions.get(key);
    if (!pending) {
      pending = composio.sessions.create(
        ownerId,
        {
          toolkits: [call.toolkit],
          connectedAccounts: { [call.toolkit]: call.accountId },
          instant: false,
          ...READ_ONLY,
        },
        { signal },
      );
      sessions.set(key, pending);
      pending.catch(() => sessions.delete(key));
    }
    const session = await pending;
    // @composio/core 0.22 accepts request options at runtime but omits them
    // from the public type.
    const execute = session.execute as unknown as (
      slug: string,
      input: Record<string, unknown>,
      options: undefined,
      request: { signal?: AbortSignal },
    ) => Promise<{ data: unknown; error?: string | null }>;
    const { data, error } = await execute.call(
      session,
      call.tool,
      call.arguments,
      undefined,
      { signal },
    );
    if (error) throw new Error(String(error).slice(0, 300));
    return data;
  };
}
