import type { Connector } from './connector.js';
import { GmailConnector } from './gmail.js';
import { OutlookConnector, TeamsConnector } from './microsoft.js';

/**
 * The services a user signs in to, set up from the environment. A service
 * without its client id and secret still lists, as not set up, so the
 * interface can say what is missing. Refresh tokens are long lived logins, so
 * they are never stored without SECRETS_KEY.
 */
export function signInConnectors(
  env: Record<string, string | undefined>,
  fetcher: typeof fetch = fetch,
): Connector[] {
  const client = (id?: string, secret?: string) =>
    id?.trim() && secret?.trim()
      ? { clientId: id.trim(), clientSecret: secret.trim() }
      : undefined;
  const google = client(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
  const base = client(env.MICROSOFT_CLIENT_ID, env.MICROSOFT_CLIENT_SECRET);
  const microsoft = base && {
    ...base,
    tenant: env.MICROSOFT_TENANT?.trim() || undefined,
  };
  if ((google || microsoft) && !env.SECRETS_KEY?.trim())
    throw new Error(
      'Set SECRETS_KEY (any long random string) to connect Gmail, Outlook or Teams: it encrypts the saved sign-ins.',
    );
  return [
    new GmailConnector(google, fetcher),
    new OutlookConnector(microsoft, fetcher),
    new TeamsConnector(microsoft, fetcher),
  ];
}
