# Running the template

OpenDots runs a React app, a Node server and a Postgres database. The server stores conversations, pages, Space and Dot configuration and background work in Postgres, and connects to your configured model and messaging services.

## Local development

Use Node.js 24, npm and Docker (for the database).

```sh
npm ci
cp .env.example .env
npm run db    # Postgres in Docker, on 127.0.0.1:5432
npm run dev
```

`npm run db` starts only the `postgres` service from `compose.yml`, with the `pgvector/pgvector` image. To use a Postgres server of your own instead, point `DATABASE_URL` at an empty database; it needs the `vector` extension (pgvector) installed, and a role allowed to create the `vector` and `pg_trgm` extensions on first start. The server creates and upgrades its tables itself when it starts.

Open http://127.0.0.1:5173. The API runs on port 4310. Without service credentials, the app shows its setup state; it does not generate simulated replies.

During `npm run dev`, both http://localhost:5173 and http://127.0.0.1:5173 are allowed browser origins. The UI sends API requests through Vite's `/api` proxy. To use a different proxy or custom domain, set `APP_ORIGIN` to one exact origin or a comma-separated list, for example `APP_ORIGIN=http://localhost:5173,http://127.0.0.1:5173`. An explicit value replaces the development defaults. Origins must match the scheme, hostname, and port exactly; omit paths and trailing slashes. Whitespace around list entries is trimmed and empty entries are ignored. Outside development, leaving `APP_ORIGIN` unset requires the browser origin to match the request URL's origin. This setting preserves cross-site request blocking; it does not enable direct cross-origin browser access to the API.

For a built local app:

```sh
npm run build
npm start
```

Open http://127.0.0.1:4310. Keep the server running for background work.

## Conversations

OpenDots stores conversations itself, in the same Postgres database as pages and workspace metadata (`DATABASE_URL`). You only need an OpenAI-compatible model key. History survives restarts, refreshing during an answer reconnects to it, and a turn started elsewhere (a schedule, a voice call, another device) appears live in an open chat. Back up the database (for example with `pg_dump`) to back up conversations.

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
| `DATABASE_URL`                   | Postgres database with conversations, pages, workspace and work    |
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

Back up the database: it contains page content and conversation history. The template does not include multi-user page sharing, realtime collaboration, file uploads, or arbitrary interactive embeds.

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

## Discovery

Discovery watches chosen accounts and tells you when something needs you, without being asked. Turn it on per account on the **Accounts** page (Gmail, Outlook and Microsoft Teams today) and pick the Dot that looks into what it finds.

1. **Read.** Every five minutes OpenDots reads new items on that account with read-only Composio tools (`GMAIL_FETCH_EMAILS`, `OUTLOOK_LIST_MESSAGES`, or Teams chats and their messages). The first check looks back one day. Items appear in the **Inbox**.
2. **Gather history.** Before judging, code finds earlier items the new one could relate to: items sharing a tag (an invoice or order number, ticket, person, project, place or name; exact keys first, then near spellings), items from the same sender in the last three days, and, when an embedding model is set, the items closest in wording. When a person or name in the item matches no earlier one exactly but resembles some, Jev is asked which, if any, it is (one yes/no question per candidate, then a Choice over the strongest); a clear match is saved as a tag. Mail the provider already filed as promotions, social or spam is skipped without a model call.
3. **Judge with that history.** One [Jev](https://docs.typesafe.ai) call per item (TypeSafe's System One model) answers: does the owner need to see it, what kind it is, how urgent (can wait days, by tomorrow, today, within hours), what it asks for (nothing, information, a reply, an action, or a decision only you can make), and whether it tries to instruct an AI assistant. For each earlier item it also answers: the same thing? does the new item say it no longer needs you? does it make it more urgent? is it useful for answering, or does it contradict? Every raw answer is stored with the finding, so thresholds can be retuned on past items without new calls. Items below `DISCOVERY_THRESHOLD` (0.6) are not flagged.
4. **Update earlier items (code).** A "same thing" score of 0.8 or more links the two items; 0.5 to 0.8 waits under **Links to review** on the Inbox **Brief** tab for you to confirm or reject, and a rejected pair is never linked again. "No longer needed" resolves the earlier item and cancels its waiting push, or sends a short correction if the push already went out, but only when it comes from the earlier item's own sender or from the addresses and domains you list as yours; from anyone else the item stays flagged with a note. An item that reads as instructing an AI never resolves anything. "More urgent" is accepted from anyone: the earlier item's urgency goes up, and if it had been ignored it is flagged and looked into.
5. **Route (code).** What is asked decides what the Dot does: nothing asked, it only tells you; information or a reply, it drafts the reply in the conversation; an action, it proposes it for your approval in apps you allow (Accounts, **Apps where a Dot may propose actions**) and otherwise tells you what is needed, where and who asked; a decision, it gathers the facts and options and proposes nothing. Items that try to instruct an AI are shown to you and never handed to a Dot.
6. **Investigate, read-only.** Each flagged item that needs more than a mention gets its own conversation with the chosen Dot (up to five per check, highest confidence first). A follow-up to an item already being discussed continues that conversation, and earlier items Jev found useful or contradicting are quoted for the Dot. The Dot can only read: Composio is limited to tools tagged `readOnlyHint`, every app tool is checked again before it runs, the remote workbench and new sign-ins are off, and only connection tools marked read-only that run without asking are offered. It cannot write pages, use the computer or ask other Dots. It replies with what came in, what it found and what it suggests.
7. **Deliver.** Within hours: a push now, even in quiet hours. Today: a push after a short hold (5 minutes by default), so a quick follow-up can cancel it; in quiet hours it waits for the brief. By tomorrow or later: the morning brief, one push a day at the time you choose, filed under decisions, drafts to approve and updates. The **Brief** tab shows what the next brief holds and what the last one held. Set the brief time, quiet hours (22:00 to 07:00 by default), the hold, your time zone, your own addresses and domains, and the apps where Dots may propose actions under **When discovery tells you** on the **Accounts** page.
8. **You decide.** When the Dot has looked into an item, it waits on the Inbox **For you** tab (and the mobile app's **Inbox** screen), most important first, with three choices. Each runs in the item's own conversation, so you can ask the Dot questions there first.
   - **Prepare it for me:** the Dot researches with read-only app tools, saves a page with the plan, the context and links, and writes any replies as drafts in the conversation. Nothing leaves OpenDots.
   - **Handle it:** the Dot carries out the plan with its normal tools. Every change, send or reply asks for your approval in the conversation first, and a push tells you when one is waiting. This choice only appears where the Dot may act: a reply it can draft, or an action in an app you allow.
   - **Not now:** snooze it for 3 hours or until the next morning brief, or dismiss it. Once you have dismissed a sender's items twice in 90 days, and prepared or handled none of them, their new items stop being flagged, unless they are needed within hours. Quieted senders are listed on the **For you** tab with **Flag again** to undo.

   With the mobile app, the push has these choices as buttons. Drafts stay in the conversation; nothing is sent from your mailbox without your approval.

Set `TYPESAFE_API_KEY` to turn discovery on — get a key from [typesafe.ai](https://typesafe.ai). Without it, discovery stays off and nothing is read or sent.

Similar items are optional. Set `EMBEDDING_BASE_URL` to any OpenAI-compatible embeddings endpoint, ideally a local one so mail text stays on your machine, for example [Ollama](https://ollama.com) with `ollama pull nomic-embed-text`, `EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1` and `EMBEDDING_MODEL=nomic-embed-text`. Earlier items are embedded in the background at startup. Embeddings only find candidates; whether two items are the same thing is always Jev's call.

Items are untrusted data: Jev and the investigating Dot are both told never to follow instructions inside them, and claims such as "payment made" are treated as claims until another source confirms them. Discovery does not change the Inbox notification setting of other sources; discovery sources notify when a Dot has something to say, not per item.

### Links between items

Each new inbox item is scanned for invoice and order numbers, ticket keys, amounts, email addresses, company domains and sender names. Spellings of one identifier share a key (`INV-2041`, `inv 2041` and `Invoice #2041`), and tags are kept after the item itself is pruned. The Inbox **Links** tab shows items on a timeline, one lane per source; pick a tag to join the items that carry it, and tags spelled alike (`INV-2041` and `INV-2014`) join with a dashed line, since they may be the same thing or a typo.

Names need no list of types. Any run of capitalised words is a name tag (`Acme Supplies`, `Initech`), and so is a `#hashtag`; a cue word types it: `Project Falcon` or `the Falcon project` is a project, `the Cape Town office` or `in Durban` is a place. A name links on the name alone, so `Project Falcon`, `#falcon` and `the Falcon review` are one tag, shown under its most specific kind. Single names are noisy, so only names found in two or more items appear. A lone capital at the start of a sentence, codes in capitals, weekdays, months, greetings and common words are skipped. Upgrading retags the items still in the inbox once, at startup. This is code only: no model call. To try it with made-up items, run `npm run seed-demo`: it also adds made-up discovery results (judged by "demo", no model call), links, a link to review and a waiting brief; `npm run seed-demo -- --remove` takes them out again. `npm run seed-scenarios` adds six made-up scenarios (an unnamed app idea and its proposal, a paid invoice, a lookalike sender, an outage, a moved meeting, a hire) to the Inbox; `npm run seed-scenarios -- --judge` has Jev judge them in order and grades each scenario's checks. Judging sends that made-up text to TypeSafe with your `TYPESAFE_API_KEY`, about one call per new item.

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

Open http://localhost:4310. The app port binds to loopback. The browser service is optional: set a 24+ character `BROWSER_SECRET` and run `docker compose --profile browser up --build` to enable it; it has no published port. Everything OpenDots stores lives in the `postgres` service and its `opendots-postgres` volume; the database port is published on loopback only. Set `POSTGRES_PASSWORD` in `.env` before the first start to change the default password (`opendots`); changing it later means changing it inside Postgres too. To back up:

```sh
docker compose exec postgres pg_dump -U opendots opendots > opendots.sql
```

```sh
# Stop services while retaining saved data.
docker compose down
```

For remote hosting, configure an HTTPS reverse proxy and the matching `APP_ORIGIN`. See [Security](../SECURITY.md) for the template's deployment boundary.

### Moving from SQLite

Releases before Postgres kept everything in one SQLite file (`DATABASE_PATH`, by default `data/opendots.sqlite`, or `/data/opendots.sqlite` in the `opendots-data` volume). The server no longer reads it, and warns at startup while `DATABASE_PATH` is still set. Copy it into Postgres once:

```sh
# Running from source: start the database, then import.
npm run db
npm run import-sqlite -- data/opendots.sqlite

# Running in Compose: the old file is still in the opendots-data volume.
docker compose up -d postgres
docker compose run --rm app node dist/server/server/db/import-cli.js /data/opendots.sqlite
```

The import copies every table, keeps rows in their original order and leaves the SQLite file unchanged. It refuses to run if the Postgres database already has conversations, tasks, pages, memories, inbox sources or connections, so it never merges two histories; the Space and Dot a fresh install creates on first start are replaced. Columns left from retired features (the Intelligence learning fields) are not copied, and the import lists them. Then remove `DATABASE_PATH` from `.env`.

### Cloudflare Tunnel

To reach OpenDots on a machine that cannot accept incoming connections, such as a home PC behind a router without port forwarding, use a Cloudflare Tunnel. The PC connects out to Cloudflare; no ports are opened, and Cloudflare serves HTTPS on your domain. The tunnel is free, but on Cloudflare's free plan the domain's DNS must be managed by Cloudflare.

1. Add the domain to Cloudflare (free plan) and change its nameservers at your registrar to the two Cloudflare shows. Existing DNS records are copied; check any mail records before switching.
2. In the Cloudflare dashboard open **Zero Trust → Networks → Tunnels → Create a tunnel**, choose **Cloudflared**, name it, and copy the token from the install command.
3. On the tunnel's **Public hostname** tab add `dots.yourdomain.co.za` with service type `HTTP` and URL `app:4310`.
4. In `.env`:

   ```sh
   OWNER_TOKEN=<24+ random characters>
   APP_ORIGIN=https://dots.yourdomain.co.za,http://localhost:4310
   CLOUDFLARE_TUNNEL_TOKEN=<token from step 2>
   ```

5. Start the app with the tunnel:

   ```sh
   docker compose --profile tunnel up --build -d
   ```

Open `https://dots.yourdomain.co.za` and sign in with `OWNER_TOKEN`. Cloudflare decrypts traffic at its edge before passing it through the tunnel, so it can see what the app shows. You can put Cloudflare Access (free for up to 50 users) in front as an extra sign-in; if you do, bypass it for `/api/inbox/hooks/*` and for the mobile app, which cannot complete a browser sign-in.

The site is only up while the PC is on and awake.

## Automatic Learning

Automatic Learning was a CopilotKit Intelligence feature and is not available now that conversations are stored locally. An OpenDots learning loop that drafts skills for your review is planned (see [ROADMAP.md](ROADMAP.md#learning-later)).

## Development checks

```sh
npm run check-format
npm run lint
npm run typecheck
npm run test:db   # once: a throwaway Postgres for tests on 127.0.0.1:54329
npm test
npm run build
```

Tests run against Postgres: each test gets its own schema, dropped when it ends. `npm run test:db` starts the `postgres-test` Compose service, which keeps its data in memory; set `TEST_DATABASE_URL` to use another server. Automated tests use service fixtures. Live model, Slack, and voice verification requires your own configured services.
