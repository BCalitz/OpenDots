import { z } from 'zod';
import type {
  ConnectionActionResult,
  ConnectorTool,
} from '../../shared/connection-types.js';
import type { ConnectorTarget } from './connector.js';
import { signInOnly, type OAuthApp, type OAuthConnector } from './oauth.js';

const MAX_RESULT_CHARS = 20_000;

/** One tool of a service written in this process, with its input checked by zod. */
export interface ApiTool<T extends z.ZodType = z.ZodType> {
  name: string;
  title: string;
  description: string;
  /** Reads only. Anything that sends, writes or deletes leaves this false. */
  readOnly: boolean;
  input: T;
  run(args: z.infer<T>, call: ApiCall): Promise<unknown>;
}
export interface ApiCall {
  /** Calls the service with the account's access token; returns its JSON. */
  json(
    url: string,
    init?: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
    },
  ): Promise<unknown>;
}
export const tool = <T extends z.ZodType>(value: ApiTool<T>) =>
  value as unknown as ApiTool;

const text = (value: unknown): ConnectionActionResult => {
  const body =
    value === undefined || value === null
      ? 'Done.'
      : typeof value === 'string'
        ? value
        : JSON.stringify(value);
  return {
    isError: false,
    text:
      body.length > MAX_RESULT_CHARS
        ? `${body.slice(0, MAX_RESULT_CHARS)}\n[truncated]`
        : body,
  };
};
const failure = (message: string): ConnectionActionResult => ({
  isError: true,
  text: message,
});

/**
 * A service the user signs in to and whose tools are plain TypeScript in this
 * process: it calls the service's REST API with the account's access token.
 * Subclasses say what the service offers; this does the rest.
 */
export abstract class ApiConnector implements OAuthConnector {
  abstract readonly kind: string;
  abstract readonly label: string;
  /** Looks up who an access token belongs to. */
  protected abstract identity(
    call: ApiCall,
  ): Promise<{ name: string; email: string }>;
  constructor(
    readonly app: OAuthApp | undefined,
    private tools: ApiTool[],
    private fetcher: typeof fetch = fetch,
  ) {}
  parse = signInOnly;
  describe(config: Record<string, unknown>) {
    return `${this.label}${config.email ? ` · ${String(config.email)}` : ''}`;
  }
  private async caller(secret: string | undefined, signal?: AbortSignal) {
    if (!this.app) throw new Error(`${this.label} sign-in is not set up.`);
    const token = await this.app.accessToken(secret, signal);
    const call: ApiCall = {
      json: async (url, init = {}) => {
        const response = await this.fetcher(url, {
          method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            ...(init.body === undefined
              ? {}
              : { 'Content-Type': 'application/json' }),
            ...init.headers,
          },
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          signal: AbortSignal.any([
            AbortSignal.timeout(30_000),
            ...(signal ? [signal] : []),
          ]),
        });
        if (!response.ok) {
          const detail = (await response.json().catch(() => ({}))) as {
            error?: { message?: string } | string;
          };
          const message =
            typeof detail.error === 'string'
              ? detail.error
              : detail.error?.message;
          throw new Error(
            response.status === 401
              ? 'The service rejected the sign-in. Remove the account and connect it again.'
              : response.status === 403
                ? `The account does not allow this${message ? `: ${message.slice(0, 200)}` : '.'}`
                : `${this.label} returned an error (${response.status})${message ? `: ${message.slice(0, 200)}` : '.'}`,
          );
        }
        // Some calls (sending mail) answer with no body.
        const raw = await response.text();
        return raw ? JSON.parse(raw) : null;
      },
    };
    return call;
  }
  async signedIn(refreshToken: string, signal?: AbortSignal) {
    const who = await this.identity(await this.caller(refreshToken, signal));
    return { name: who.email || who.name, config: { email: who.email } };
  }
  async discover(
    target: ConnectorTarget,
    signal?: AbortSignal,
  ): Promise<ConnectorTool[]> {
    // Proves the sign-in still works, so a revoked account shows its error.
    await this.caller(target.secret, signal).then((call) =>
      this.identity(call),
    );
    return this.tools.map((item) => ({
      name: item.name,
      title: item.title,
      description: item.description,
      inputSchema: z.toJSONSchema(item.input) as Record<string, unknown>,
      readOnly: item.readOnly,
    }));
  }
  async call(
    target: ConnectorTarget,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ConnectionActionResult> {
    const found = this.tools.find((item) => item.name === name);
    if (!found) return failure('This service has no such tool.');
    const parsed = found.input.safeParse(args);
    if (!parsed.success)
      return failure(
        `Invalid arguments: ${parsed.error.issues[0]?.message ?? 'check the input.'}`,
      );
    try {
      return text(
        await found.run(parsed.data, await this.caller(target.secret, signal)),
      );
    } catch (error) {
      return failure(
        error instanceof Error && error.message
          ? error.message
          : 'Could not reach the connected service.',
      );
    }
  }
}
