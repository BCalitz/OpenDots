import type { JSONSchema } from '@tanstack/ai';
import type { Tool } from './engine/tools.js';
import type { composioSession } from './composio.js';
import { safeFailure } from './channels/adapter.js';
import type { UsageStore } from './usage-store.js';

type Session = Awaited<ReturnType<typeof composioSession>>;
type CancellableSession = Session & {
  tools(
    modifiers: Parameters<Session['tools']>[0],
    requestOptions: { signal?: AbortSignal },
  ): ReturnType<Session['tools']>;
  execute(
    toolSlug: string,
    input: Record<string, unknown>,
    options: Parameters<Session['execute']>[2],
    requestOptions: { signal?: AbortSignal },
  ): ReturnType<Session['execute']>;
};

/** Meta tools that can run code or start sign-ins; never in read-only turns. */
const NOT_READ_ONLY = new Set([
  'COMPOSIO_REMOTE_WORKBENCH',
  'COMPOSIO_REMOTE_BASH_TOOL',
  'COMPOSIO_MANAGE_CONNECTIONS',
]);
/** Meta tools that only look tools up. */
const LOOKUP = new Set(['COMPOSIO_SEARCH_TOOLS', 'COMPOSIO_GET_TOOL_SCHEMAS']);
const MULTI_EXECUTE = 'COMPOSIO_MULTI_EXECUTE_TOOL';

/** The app tools a call would run: one, or each item of a multi-execute. */
export function toolSlugs(name: string, input: unknown): string[] {
  if (LOOKUP.has(name)) return [];
  if (name !== MULTI_EXECUTE) return [name];
  const items = (input as { tools?: unknown } | undefined)?.tools;
  if (!Array.isArray(items)) return [''];
  return items.map((item) =>
    String((item as { tool_slug?: unknown } | null)?.tool_slug ?? ''),
  );
}

export async function composioTools(
  session: Session,
  check: () => void,
  signal?: AbortSignal,
  log?: { store: UsageStore; dotId: string; threadId: string },
  /**
   * Set for read-only turns such as discovery investigations: every tool a
   * call would run must pass, or nothing runs.
   */
  readOnly?: (slug: string) => Promise<boolean>,
) {
  check();
  // @composio/core 0.22 supports request options at runtime but omits them
  // from the public Session function aliases.
  const cancellable = session as CancellableSession;
  const tools = await cancellable.tools(undefined, { signal });
  return tools
    .filter((tool) => tool.type === 'function')
    .filter((tool) => !readOnly || !NOT_READ_ONLY.has(tool.function.name))
    .map(({ function: fn }): Tool => ({
      name: fn.name,
      description: fn.description ?? `Use the Composio ${fn.name} tool.`,
      parameters: (fn.parameters ?? { type: 'object' }) as JSONSchema,
      execute: async (input: unknown) => {
        check();
        if (readOnly) {
          for (const slug of toolSlugs(fn.name, input))
            if (!slug || !(await readOnly(slug)))
              return {
                data: {},
                error: `This turn is read-only, so ${slug || 'that tool'} did not run: it can change things in the owner's account. Describe it in your proposal instead.`,
              };
          check();
        }
        // Composio slugs start with the toolkit, e.g. GMAIL_SEND_EMAIL.
        const entry = log?.store.beginAction({
          dotId: log.dotId,
          threadId: log.threadId,
          kind: 'app',
          target: fn.name.split('_')[0]?.toLowerCase() || 'composio',
          action: fn.name,
        });
        try {
          const { data, error } = await cancellable.execute(
            fn.name,
            input as Record<string, unknown>,
            undefined,
            { signal },
          );
          if (entry)
            log!.store.finishAction(entry, error ? 'failed' : 'succeeded');
          return { data, error };
        } catch (error) {
          if (entry) log!.store.finishAction(entry, 'failed');
          return {
            data: {},
            error: `Composio tool failed: ${safeFailure(error)}.`,
          };
        }
      },
    }));
}
