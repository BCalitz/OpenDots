import { createHash, randomBytes } from 'node:crypto';
import { sql, type Db } from '../db/index.js';
import type { Connector } from './connector.js';
import type { ConnectorService } from './service.js';

const STATE_TTL_MS = 10 * 60_000;

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}
export interface OAuthEndpoints {
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** Extra authorize parameters, such as Google's offline access. */
  authorizeParams?: Record<string, string>;
}

const readableError = async (response: Response) => {
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
  };
  return body.error === 'invalid_grant'
    ? 'The sign-in has expired or was revoked. Remove the account and connect it again.'
    : `The service refused the sign-in${body.error ? ` (${body.error})` : ''}.`;
};

/**
 * One OAuth client of one provider: builds the sign-in address, trades the
 * returned code for a refresh token, and turns a refresh token into short
 * lived access tokens. Only the refresh token is stored; access tokens are
 * kept in memory until they expire.
 */
export class OAuthApp {
  private cache = new Map<string, { token: string; expiresAt: number }>();
  constructor(
    readonly client: OAuthClient,
    private endpoints: OAuthEndpoints,
    private fetcher: typeof fetch = fetch,
  ) {}
  authorizeUrl(state: string, verifier: string, redirectUri: string) {
    const url = new URL(this.endpoints.authorizeUrl);
    for (const [key, value] of Object.entries({
      client_id: this.client.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: this.endpoints.scopes.join(' '),
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      ...this.endpoints.authorizeParams,
    }))
      url.searchParams.set(key, value);
    return url.toString();
  }
  private async token(params: Record<string, string>, signal?: AbortSignal) {
    const response = await this.fetcher(this.endpoints.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.client.clientId,
        client_secret: this.client.clientSecret,
        ...params,
      }),
      signal: AbortSignal.any([
        AbortSignal.timeout(30_000),
        ...(signal ? [signal] : []),
      ]),
    });
    if (!response.ok) throw new Error(await readableError(response));
    const body = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!body.access_token)
      throw new Error('The service did not return an access token.');
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    };
  }
  async exchange(code: string, verifier: string, redirectUri: string) {
    const result = await this.token({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    });
    if (!result.refreshToken)
      throw new Error(
        'The service did not allow lasting access. Try connecting again.',
      );
    this.cache.set(result.refreshToken, {
      token: result.accessToken,
      expiresAt: result.expiresAt,
    });
    return result.refreshToken;
  }
  /** A valid access token for a stored refresh token. */
  async accessToken(refreshToken: string | undefined, signal?: AbortSignal) {
    if (!refreshToken) throw new Error('This account has no sign-in saved.');
    const cached = this.cache.get(refreshToken);
    if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
    const result = await this.token(
      { grant_type: 'refresh_token', refresh_token: refreshToken },
      signal,
    );
    this.cache.set(refreshToken, {
      token: result.accessToken,
      expiresAt: result.expiresAt,
    });
    return result.accessToken;
  }
}

/** A connector whose accounts are added by signing in with the service. */
export interface OAuthConnector extends Connector {
  /** What the user sees on the connect button, such as "Gmail". */
  readonly label: string;
  /** Absent until the provider's client id and secret are configured. */
  readonly app?: OAuthApp;
  /** Who just signed in: the account's name and config. */
  signedIn(
    refreshToken: string,
    signal?: AbortSignal,
  ): Promise<{ name: string; config: Record<string, unknown> }>;
}
export const isOAuth = (connector: Connector): connector is OAuthConnector =>
  'signedIn' in connector;
/** What every sign-in connector says when asked for a typed-in account. */
export const signInOnly = (): never => {
  throw new Error('Connect this account by signing in with the service.');
};

export interface OAuthProvider {
  kind: string;
  label: string;
  configured: boolean;
}

/**
 * Sign-ins in progress. `start` records a one-time state and returns where to
 * send the user; `finish` is what the service redirects back to. The state
 * is bound to the user who started it, used once and expires, so a stray or
 * replayed redirect cannot add an account.
 */
export class OAuthFlow {
  constructor(
    private db: Db,
    private service: ConnectorService,
    /** Where the browser reaches OpenDots, such as http://localhost:4310. */
    readonly publicUrl: string,
  ) {}
  get redirectUri() {
    return `${this.publicUrl}/api/oauth/callback`;
  }
  providers(): OAuthProvider[] {
    return this.service.oauthConnectors().map((c) => ({
      kind: c.kind,
      label: c.label,
      configured: !!c.app,
    }));
  }
  async start(userId: string, kind: string, dotId?: string) {
    const connector = this.service.oauthConnector(kind);
    if (!connector.app)
      throw new Error(
        `${connector.label} sign-in is not set up on this server.`,
      );
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const now = Date.now();
    await this.db.run(sql`DELETE FROM oauth_states WHERE expires_at < ${now}`);
    await this.db.run(
      sql`INSERT INTO oauth_states (state, user_id, connector, verifier, dot_id, expires_at) VALUES (${state}, ${userId}, ${kind}, ${verifier}, ${dotId ?? null}, ${now + STATE_TTL_MS})`,
    );
    return connector.app.authorizeUrl(state, verifier, this.redirectUri);
  }
  /** Completes a sign-in: the service redirected back with a code. */
  async finish(state: string, code: string) {
    const row = await this.db.row<{
      userId: string;
      connector: string;
      verifier: string;
      dotId: string | null;
      expiresAt: number;
    }>(
      sql`DELETE FROM oauth_states WHERE state=${state} RETURNING user_id, connector, verifier, dot_id, expires_at`,
    );
    if (!row || row.expiresAt < Date.now())
      throw new Error('This sign-in has expired. Start again.');
    const connector = this.service.oauthConnector(row.connector);
    if (!connector.app)
      throw new Error('Sign-in is not set up on this server.');
    const refreshToken = await connector.app.exchange(
      code,
      row.verifier,
      this.redirectUri,
    );
    const { name, config } = await connector.signedIn(refreshToken);
    const account = await this.service.addVerified(row.userId, row.connector, {
      name,
      config,
      secret: refreshToken,
    });
    if (row.dotId)
      await this.service
        .grant(row.userId, row.dotId, account.id)
        .catch(() => undefined);
    return account;
  }
}
