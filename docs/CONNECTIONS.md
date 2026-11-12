# Connections

Connections give Dots tools from outside services: email, calendars, issue trackers, notes, or your own services. A service is reached either through a remote [MCP](https://modelcontextprotocol.io) server, or by signing in to Gmail, Outlook or Microsoft Teams.

## Accounts, grants and policies

Three ideas keep this simple:

- An **account** is one login to one service, such as your Gmail or your GitHub. You connect it once, and it belongs to one user.
- A **grant** lets one Dot use one account. A Dot can use only the accounts you grant it.
- A **policy** says what a Dot may do with each tool of a granted account: **Allow** (runs on its own), **Ask first** (you approve each call in chat) or **Block**.

Connecting the same service to five Dots is one account and five grants, so a token is stored once and reconnected once. Each Dot can still have its own policies for the same account: an assistant that only reads your mail and another that may send it.

## Add a connection

1. Open a Dot's settings (**Edit specialist**).
2. Under **Connections**, enter a name, the server's Streamable HTTP endpoint (for example `https://example.com/mcp`), and an optional bearer token.
3. Select **Connect**. OpenDots lists the server's tools, saves the account and lets this Dot use it.

To let another Dot use an account you already connected, open that Dot's settings and tick **Use in this Dot** on the account.

Use **Refresh** after the server adds or changes tools. Your policies for existing tools are kept, and new tools start with the default below. **Remove** deletes the account and takes it away from every Dot.

## Sign in to Gmail, Outlook or Teams

Under **Connections** in a Dot's settings, select **Connect Gmail**, **Connect Outlook** or **Connect Microsoft Teams**. You sign in on the service's own page, and OpenDots keeps only a refresh token, never your password. The account is then used by this Dot like any other: the same grants, policies and approvals apply.

| Service | Tools                                                                                                                        |
| ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Gmail   | search and read mail (allowed); save a draft, send, reply (ask first)                                                        |
| Outlook | search and read mail, list calendar events (allowed); save a draft, send, reply (ask first)                                  |
| Teams   | list teams, channels and chats, read channel and chat messages (allowed); send a chat message, post in a channel (ask first) |

The buttons are off until the server is set up:

1. Set `SECRETS_KEY` in `.env` to a long random string. It encrypts saved sign-ins (AES-256-GCM), and OpenDots will not start with Gmail, Outlook or Teams configured without it. Keep it with your backups: without it the saved accounts cannot be read and must be connected again. Secrets saved before a key was set are encrypted the next time the server starts.
2. Set `PUBLIC_URL` to the address your browser uses for OpenDots (default `http://127.0.0.1:<PORT>`; with `npm run dev`, use `http://localhost:5173`). The service sends you back to `<PUBLIC_URL>/api/oauth/callback`, so register exactly that as the redirect URI.
3. **Google:** in Google Cloud, create an OAuth client (type _Web application_), enable the Gmail API, and set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Gmail's read and send permissions are restricted scopes: while the app is in testing, add yourself as a test user.
4. **Microsoft:** in Microsoft Entra, register an app with a _Web_ redirect URI, add a client secret, and set `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET`. `MICROSOFT_TENANT` is `common` by default (work and personal accounts); use your tenant id to limit it to your organization. Delegated permissions needed: Mail.ReadWrite, Mail.Send, Calendars.Read (Outlook) and Team.ReadBasic.All, Channel.ReadBasic.All, ChannelMessage.Read.All, ChannelMessage.Send, Chat.Read, ChatMessage.Send (Teams). Some Teams permissions need an administrator's consent.

If a service rejects the saved sign-in later (for example you revoked access), the account shows the error and the Dot's calls fail with a message to connect it again.

## Approvals

When an account is first granted to a Dot, a tool the server marks as read-only (`readOnlyHint`) starts as **Allow**. Every other tool starts as **Ask first**. The starting policy is saved, so a server cannot later lift the approval on a tool by changing its hint.

When a Dot calls an **Ask first** tool, the tool does not run. The server stores the exact account, tool and arguments, and the Dot shows an approval card in chat with a summary and those stored arguments. The action runs only when you select **Approve & run**. It runs the stored request, never arguments sent with the approval, and only if the Dot still has that exact tool and has not been set to **Block**. Requests expire after an hour. Each approval runs at most once. Reopening the conversation shows the saved result, or keeps checking while the action is still running.

The read-only hint comes from the server, so it is only a hint. Set **Ask first** for any tool you do not fully trust, and **Block** tools a Dot does not need.

Approval cards appear in chats in the web and mobile apps. The Dot waits up to 30 minutes for your decision, and the wait does not count toward the turn's time limit. Through Slack, voice or scheduled runs, an **Ask first** tool tells the Dot to ask you to continue in a chat.

Changing a Dot's access (granting or removing an account, changing a policy, refreshing an account) stops that Dot's active turn.

## Watching a connection from the Inbox

A read-only list tool, such as "tasks assigned to me" on your ticket system's MCP server, can feed the **Inbox**. Open **Inbox**, choose **Add source**, then **Connection tool**, and pick the Dot, the tool and its arguments. OpenDots calls the tool on a timer (every 5 minutes by default) and adds any record it has not seen before. Put `"{{since}}"` in an argument to pass the time of the last check. Only tools set to **Allow** can be used, because nobody is there to approve a timed call. Every call appears in **Insights > Audit**.

Services that can send webhooks can post to a **Webhook** source instead. Its address and secret are shown once when you create it, and you can make a new secret at any time. Webhook deliveries do not use the owner token, so the server must be reachable from the sending service.

## Users

Every account belongs to a user (`accounts.user_id`), and every read or change of an account goes through that user: another user cannot list, refresh, grant, change or remove it. Today OpenDots has one user, the owner set by `OWNER_ID`, so keep that value stable. Existing connections moved to that user when this model was introduced.

Signing in is not built yet. When it is, only the one function that says who is asking (`userOf` in `src/server/connectors/routes.ts`) changes: accounts, grants and policies are already stored and checked per user. Dots do not belong to a user yet, so a grant is checked against the account's owner; Dots will get the same check when they gain an owner.

## Adding another kind of service

An account's `connector` names the code that talks to its service. Everything else (accounts, grants, policies, approvals, the Inbox) is the same for every kind. A connector implements `Connector` in `src/server/connectors/connector.ts`: it checks what the user entered, lists what the service offers, and runs a tool. `McpConnector` talks to remote MCP servers. Gmail, Outlook and Teams are written as plain TypeScript in this process (`ApiConnector` in `src/server/connectors/api.ts`: a list of tools and a way to say who signed in), with no network hop beyond the service's own API.

## Security notes

- Secrets (MCP tokens and sign-in refresh tokens) are stored in the server's Postgres database and are never sent to the browser. With `SECRETS_KEY` set they are encrypted, so a copy of the database alone is not enough; protect the key and the database the way you protect `.env`. Without a key, MCP tokens are stored as plain text.
- Sign-in redirects are bound to the user who started them, work once and expire after ten minutes.
- Tool results are passed to the model as untrusted data.
- Endpoints must use `http` or `https` and cannot contain credentials in the URL. Local addresses are allowed, so you can run MCP servers on the same machine. Only add servers you trust.
- OAuth-only servers are not supported yet. Use a server that accepts a bearer token, or put a token-authenticated proxy in front of it.
