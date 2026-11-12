import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import type {
  ConnectionActionResult,
  ConnectorTool,
} from '../../shared/connection-types.js';
import type { Connector, ConnectorTarget } from './connector.js';
const MAX_TOOLS = 100;
const MAX_SCHEMA_BYTES = 16_000;
const MAX_RESULT_CHARS = 20_000;
const mcpAccountInput = z
  .object({
    name: z.string().trim().min(1).max(40),
    url: z
      .string()
      .trim()
      .url()
      .max(2048)
      .refine((value) => {
        const url = new URL(value);
        return (
          ['http:', 'https:'].includes(url.protocol) &&
          !url.username &&
          !url.password
        );
      }, 'Use an http(s) MCP endpoint without embedded credentials.'),
    token: z.string().trim().max(4096).optional(),
  })
  .strict();
export type McpTransportFactory = (target: {
  url: string;
  token?: string;
  signal: AbortSignal;
}) => Transport;
const httpTransport: McpTransportFactory = ({ url, token, signal }) =>
  new StreamableHTTPClientTransport(new URL(url), {
    requestInit: token
      ? { headers: { Authorization: `Bearer ${token}` } }
      : undefined,
    fetch: (input, init) =>
      fetch(input, {
        ...init,
        signal: AbortSignal.any([
          signal,
          ...(init?.signal ? [init.signal] : []),
        ]),
      }),
  });
const listedTool = z.object({
  name: z.string().min(1).max(128),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()),
  annotations: z
    .object({
      title: z.string().optional(),
      readOnlyHint: z.boolean().optional(),
    })
    .passthrough()
    .optional(),
});
export function normalizeResult(result: unknown): ConnectionActionResult {
  const envelope = z
    .object({
      isError: z.boolean().optional(),
      structuredContent: z.unknown().optional(),
      content: z
        .array(
          z
            .object({ type: z.string(), text: z.string().optional() })
            .passthrough(),
        )
        .optional(),
    })
    .passthrough()
    .safeParse(result);
  if (!envelope.success)
    return {
      isError: true,
      text: 'The service returned an unreadable result.',
    };
  const parts = (envelope.data.content ?? []).map((item) =>
    item.type === 'text' ? (item.text ?? '') : `[${item.type} omitted]`,
  );
  if (!parts.some((part) => part.trim()) && envelope.data.structuredContent)
    parts.push(JSON.stringify(envelope.data.structuredContent));
  const text = parts.join('\n').trim() || '(no content)';
  return {
    isError: !!envelope.data.isError,
    text:
      text.length > MAX_RESULT_CHARS
        ? `${text.slice(0, MAX_RESULT_CHARS)}\n[truncated]`
        : text,
  };
}
const failure = (error: unknown) => {
  if (!(error instanceof Error))
    return 'Could not reach the connected service.';
  if (error.name === 'AbortError' || error.name === 'TimeoutError')
    return 'The connected service did not respond in time.';
  const status = (error as { code?: unknown }).code;
  // OAuth-only servers surface UnauthorizedError when no token is supplied.
  if (
    status === 401 ||
    status === 403 ||
    error.name === 'UnauthorizedError' ||
    error.constructor.name === 'UnauthorizedError'
  )
    return 'The connected service rejected the credentials. Check the bearer token.';
  return `Could not reach the connected service${error.message ? `: ${error.message.slice(0, 200)}` : '.'}`;
};
const target = ({ config, secret }: ConnectorTarget) => ({
  url: String(config.url),
  token: secret,
});

/**
 * A remote MCP server over Streamable HTTP. Each call opens a short session,
 * so no connection or credential is held between calls.
 */
export class McpConnector implements Connector {
  readonly kind = 'mcp';
  constructor(
    private transport: McpTransportFactory = httpTransport,
    private timeoutMs = 60_000,
  ) {}
  parse(input: unknown) {
    const { name, url, token } = mcpAccountInput.parse(input);
    return { name, config: { url }, secret: token || undefined };
  }
  describe(config: Record<string, unknown>) {
    try {
      return new URL(String(config.url)).host;
    } catch {
      return '';
    }
  }
  private async session<T>(
    account: { url: string; token?: string },
    signal: AbortSignal | undefined,
    use: (client: Client, signal: AbortSignal) => Promise<T>,
  ) {
    const bounded = AbortSignal.any([
      AbortSignal.timeout(this.timeoutMs),
      ...(signal ? [signal] : []),
    ]);
    const client = new Client({ name: 'opendots', version: '0.1.0' });
    try {
      await client.connect(this.transport({ ...account, signal: bounded }), {
        signal: bounded,
      });
      return await use(client, bounded);
    } finally {
      await client.close().catch(() => {});
    }
  }
  async discover(account: ConnectorTarget, signal?: AbortSignal) {
    try {
      return await this.session(
        target(account),
        signal,
        async (client, bounded) => {
          const tools: ConnectorTool[] = [];
          let cursor: string | undefined;
          do {
            const page = await client.listTools(cursor ? { cursor } : {}, {
              signal: bounded,
            });
            for (const raw of page.tools) {
              const parsed = listedTool.safeParse(raw);
              if (!parsed.success || tools.length >= MAX_TOOLS) continue;
              const tool = parsed.data;
              if (JSON.stringify(tool.inputSchema).length > MAX_SCHEMA_BYTES)
                continue;
              tools.push({
                name: tool.name,
                title: tool.title ?? tool.annotations?.title ?? tool.name,
                description: (tool.description ?? '').slice(0, 1000),
                inputSchema: { type: 'object', ...tool.inputSchema },
                readOnly: tool.annotations?.readOnlyHint === true,
              });
            }
            cursor = page.nextCursor;
          } while (cursor && tools.length < MAX_TOOLS);
          return tools;
        },
      );
    } catch (error) {
      throw new Error(failure(error), { cause: error });
    }
  }
  async call(
    account: ConnectorTarget,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ConnectionActionResult> {
    try {
      return await this.session(
        target(account),
        signal,
        async (client, bounded) =>
          normalizeResult(
            await client.callTool({ name: tool, arguments: args }, undefined, {
              signal: bounded,
            }),
          ),
      );
    } catch (error) {
      return { isError: true, text: failure(error) };
    }
  }
}
