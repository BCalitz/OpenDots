# Running the template

OpenDots runs a React app and a Node server. The server stores pages, Space and Dot configuration, and thread bindings in SQLite and stores conversations in the same SQLite database, and connects to your configured model and messaging services.

## Local development

Use Node.js 24 and npm.

```sh
npm ci
cp .env.example .env
npm run dev
```

Open http://127.0.0.1:5173. The API runs on port 4310. Without service credentials, the app shows its setup state; it does not generate simulated replies.

During `npm run dev`, both http://localhost:5173 and http://127.0.0.1:5173 are allowed browser origins. The UI sends API requests through Vite's `/api` proxy. To use a different proxy or custom domain, set `APP_ORIGIN` to one exact origin or a comma-separated list, for example `APP_ORIGIN=http://localhost:5173,http://127.0.0.1:5173`. An explicit value replaces the development defaults. Origins must match the scheme, hostname, and port exactly; omit paths and trailing slashes. Whitespace around list entries is trimmed and empty entries are ignored. Outside development, leaving `APP_ORIGIN` unset requires the browser origin to match the request URL's origin. This setting preserves cross-site request blocking; it does not enable direct cross-origin browser access to the API.

For a built local app:

```sh
npm run build
npm start
```

Open http://127.0.0.1:4310. Keep the server running for background work.

## Conversations

OpenDots stores conversations itself, in the same SQLite file as pages and workspace metadata (`DATABASE_PATH`). You only need an OpenAI-compatible model key. History survives restarts, refreshing during an answer reconnects to it, and a turn started elsewhere (a schedule, a voice call, another device) appears live in an open chat. Back up `DATABASE_PATH` to back up conversations.

Each Dot has one continuing chat. The model sees a recent window of it (about the last 80 messages, up to roughly 120,000 characters, starting at a user message) rather than all of it, so long-running chats keep working and their cost stays bounded.

Earlier releases could store conversations in CopilotKit Intelligence (`CONVERSATION_BACKEND=intelligence`). That option is gone: conversations kept there are not imported, and the server prints a notice at startup naming any `INTELLIGENCE_*`, `CPK_INTELLIGENCE_API_KEY`, `CONVERSATION_BACKEND` or `SLACK_CHANNEL_NAME` setting that is still present, so you can remove it.

### Connection settings

Edit `.env` on the server and restart after changes:

| Variable                         | Purpose                                                            |
| -------------------------------- | ------------------------------------------------------------------ |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | Model credential and model identifier                              |
| `OPENAI_BASE_URL`                | Compatible model API endpoint                                      |
| `AGENT_RUN_TIMEOUT_MS`           | Longest a turn may run, excluding time spent waiting for approvals |
| `OWNER_ID`                       | Stable identity used for this deployment's conversations           |
| `DATABASE_PATH`                  | SQLite file with conversations, pages, workspace and work metadata |
| `OWNER_TOKEN`                    | Application access token; required for external bindings           |
| `APP_ORIGIN`                     | Comma-separated exact browser origins for a proxy or custom domain |

Provider credentials belong in `.env`, not client-side variables or source code.

### Approvals

Tools that change things wait for you. When a Dot wants to save a page you asked to review, or run a connected-service tool set to **Ask first**, the chat shows a card with exactly what will happen. **Approve** runs it once on the server and the Dot carries on; **Decline** tells the Dot not to. The Dot waits up to 30 minutes, and the wait does not count toward `AGENT_RUN_TIMEOUT_MS`. Cards work the same in the web and mobile apps, and survive a page refresh. Stopping the answer, or restarting the server, closes any request still waiting. Schedules, voice and Slack cannot ask, so those tools stay unavailable there.

## Pages and page conversations

Select a Space to open its page library. Search for a document, switch between grid and list views, or create a new page. The visual editor supports formatting, headings, lists, checklists, tables, and slash commands. Use `/` to insert a block and Cmd/Ctrl+S to save immediately. Pages autosave after editing pauses; the save status tells you whether changes reached the server.

Page actions include creating subpages, moving a page within its Space, deleting a page (its subpages move up to the deleted page's parent), and editing Markdown source. Existing documents with unsupported visual-editor syntax stay in source mode to preserve their content. Manual editing works without conversation credentials.

Open a page's chat and choose a specialist with access to that Space. Grant access from the Dot’s settings in the sidebar. The server creates or reuses a conversation for that page and specialist. The Dot receives the current saved page as context and can read, create, and edit pages in its authorized Spaces. The page conversation uses that page’s Space by default; other chats use the Dot’s default page destination. Save your manual edits before asking it to revise the document. Revision checks reject stale writes; a conflict keeps your local draft available for recovery. Failed saves stop automatic retries until you retry or resolve the conflict, so a disconnected session does not silently replace newer content.

Use the conversation's save-to-page action to create a document from its saved text history. This requires a working conversation service. Pages retain a link to the source conversation, and page links in chat open the document workspace.

Back up `DATABASE_PATH`: it contains page content and conversation history. The template does not include multi-user page sharing, realtime collaboration, file uploads, or arbitrary interactive embeds.

## Browser tool

Parallel is selected by default (`WEB_SEARCH_PROVIDER=parallel`). Live research needs the model configuration, but no browser worker. An optional server-side `PARALLEL_API_KEY` enables authenticated usage and higher limits. The anonymous MCP endpoint is free for light use. Queries, selected URLs, research objectives and a stable session identifier go to Parallel. See [public-web research](../README.md#public-web-research) for data sharing, permissions and limitations.

Set `WEB_SEARCH_PROVIDER=disabled` to turn off these research tools, or `WEB_SEARCH_PROVIDER=browser` for the existing URL-only reader. The browser service reads a supplied public URL and returns page text and a capture. Configure `BROWSER_URL` and `BROWSER_SECRET`, then run:

```sh
npx playwright install chromium
npm run browser
```

Use the same secret on the app and browser processes. Browser navigation is read-only with JavaScript disabled. Private addresses, redirects, and authenticated pages are unsupported; provide a canonical public URL. This is a bounded research tool, not a general desktop or shell.

## Composio

Set `COMPOSIO_API_KEY` to let Dots use the owner’s connected apps. Restart OpenDots, enable Connected apps in the global settings and for a Dot, then optionally restrict that Dot to comma-separated toolkit slugs such as `gmail` or `googlecalendar`. Leaving the toolkit list blank lets the Dot search every toolkit available to the Composio project.

Connected apps remain disabled when you add the API key. Composio tools can read and change data in real accounts, and a blank toolkit list permits every toolkit available to the Composio project. The global and per-Dot switches require the owner to grant that access explicitly.

OpenDots uses the stable `OWNER_ID` as the Composio user identity. Do not change it after connecting accounts. Sign in to apps on the **Accounts** page: pick an app, finish the provider’s sign-in in the tab that opens, and the page shows it as Connected. You can also disconnect or reconnect accounts there. When a Dot needs an app you have not connected, it shows the same kind of Connect link in chat. The page lists only status and app names; Composio keeps the sign-in tokens. Disabling either permission prevents new app calls and stops active work. Without `COMPOSIO_API_KEY`, no Composio client or tools are created and the controls stay hidden.

To test the integration, configure a working model, limit a Dot to one toolkit, and start with a read-only request such as listing recent messages or calendar events. Complete the Connect flow when prompted, then repeat the request. Test write actions only with an account where an accidental change is safe.

Tool arguments and results pass through Composio and the connected app provider. Keep credentials in the server environment and review [Composio’s documentation](https://docs.composio.dev) and each provider’s privacy and retention terms.

## Persistent Dot computers

For a separate browser, persistent files, and optional shell for each specialist, follow [Computer setup](COMPUTERS.md). This uses pinned OpenBot computer/supervisor services and per-Dot permissions. Parallel research tools remain available alongside configured computer tools. With the browser provider selected, Dots use their computer tools in place of the read-only public-page tool; enable each Dot's required capabilities before use.

## Slack

A Dot can answer in Slack. OpenDots connects with [Socket Mode](https://api.slack.com/apis/socket-mode): the server opens an outbound connection to Slack, so it needs no public address or webhook. Replies use Slack's Web API.

### Create the Slack app

1. At [api.slack.com/apps](https://api.slack.com/apps), create an app **from a manifest** in your workspace and paste:

   ```yaml
   display_information:
     name: OpenDots
   features:
     bot_user:
       display_name: OpenDots
     app_home:
       messages_tab_enabled: true
       messages_tab_read_only_enabled: false
   oauth_config:
     scopes:
       bot:
         - app_mentions:read
         - chat:write
         - channels:history
         - groups:history
         - im:history
   settings:
     event_subscriptions:
       bot_events:
         - app_mention
         - message.channels
         - message.groups
         - message.im
     socket_mode_enabled: true
   ```

2. Under **Basic Information → App-Level Tokens**, create a token with the `connections:write` scope. This is `SLACK_APP_TOKEN` (`xapp-…`).
3. Install the app to your workspace. The **Bot User OAuth Token** is `SLACK_BOT_TOKEN` (`xoxb-…`).
4. Invite the bot to the channels where you want to use it.

### Connect a specialist

```dotenv
SLACK_BOT_TOKEN=xoxb-REPLACE
SLACK_APP_TOKEN=xapp-REPLACE
SLACK_TEAM_ID=T_REPLACE_WITH_WORKSPACE_ID
SLACK_USER_IDS=U_REPLACE_WITH_YOUR_USER_ID
SLACK_DOT_ID=REPLACE_WITH_DOT_ID
```

`SLACK_TEAM_ID` and the comma-separated `SLACK_USER_IDS` restrict who may talk to the specialist. `SLACK_DOT_ID` selects an existing Dot; find IDs in the authenticated `/api/workspace` response. If omitted, it defaults to the initial Dot. Keep both tokens on the server.

Restart OpenDots and check Slack status in Settings & setup: `connecting`, then `online`. `activation_failed` means Slack rejected a token at startup.

Mention the bot in a channel, or send it a direct message, to start a conversation. Each Slack thread is one OpenDots conversation: replies in that thread continue it, one answer at a time, and you can open it in the app. Unrelated threads, bot messages, edits, deletions and users outside the allowlist are ignored. When OpenDots is paused, the bot says so instead of answering. Errors never include details in Slack.

This template maps permitted Slack users to the single OpenDots owner. Replies are visible to the Slack conversation's audience, so choose the specialist's Space access and permitted tools accordingly. This is not a multi-user identity model.

### Verify your deployment

From an allowed user, mention the bot and verify a reply in the same thread. Reply in that thread and confirm continuity. Check that an unrelated thread and an unapproved user get no answer. Pause the assistant in OpenDots and verify that a permitted request receives the paused notice.

Local tests exercise the adapter and the channel service with a fake Slack connection. A live mention and reply remain unverified until you connect your own Slack app.

## Calls

The included speech adapter uses the Realtime API at `api.openai.com`. Set `VOICE_API_KEY` to a key with access to that API and `VOICE_MODEL` to a supported Realtime model (the local UI test used `gpt-realtime-2.1`); `VOICE_NAME` selects the voice. `OPENAI_BASE_URL` changes the compute model endpoint only, not speech. Calls use browser microphone access and WebRTC. Hosted deployments need HTTPS. The server mediates provider setup and delegates compute to the selected Dot's conversation.

A configured key is not evidence of a successful call. Verify microphone access, audio playback, compute delegation, interruption, hangup, and the saved receipt with your deployment before relying on voice workflows.

## Containers

Set `OWNER_TOKEN` and `BROWSER_SECRET` to different random secrets of at least 24 characters in `.env`, then run:

```sh
docker compose up --build -d
```

Open http://localhost:4310. The app port binds to loopback. The browser service is optional: set a 24+ character `BROWSER_SECRET` and run `docker compose --profile browser up --build` to enable it; it has no published port. Application metadata lives in the `opendots-data` volume.

```sh
# Stop services while retaining saved data.
docker compose down
```

For remote hosting, configure an HTTPS reverse proxy and the matching `APP_ORIGIN`. See [Security](../SECURITY.md) for the template's deployment boundary.

## Automatic Learning

Automatic Learning was a CopilotKit Intelligence feature and is not available now that conversations are stored locally. An OpenDots learning loop that drafts skills for your review is planned (see [ROADMAP.md](ROADMAP.md), phase 8).

## Development checks

```sh
npm run check-format
npm run lint
npm run typecheck
npm test
npm run build
```

Automated tests use service fixtures. Live model, Slack, and voice verification requires your own configured services.
