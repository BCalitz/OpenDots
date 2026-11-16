# Roadmap: an assistant that comes to you

OpenDots watches your mail, messages and calendar, works out what needs you, and comes to you with it: "reply to Thandi about the invoice", "follow up with Acme, it's been five days", "you promised the quote by Friday". It prepares the reply or the action, and you decide.

You talk to it. Calling the assistant is the main way to use it: it walks you through your day and you answer out loud or with a tap. A chat log sits beside the call, and the home screen shows the day at a glance.

This page lists what is built, the rules new work follows, and a plan for each feature that is left. Features in the phase being built have a full build spec in [specs/](specs/README.md). The screens are drawn in the [design canvas](https://claude.ai/artifact/C8YuNty1R1zDMZhgmg95VX).

- **Version 1 is a desktop app for one person.** The owner uses it daily first, so the experience comes before sign-in.
- **It will serve many users.** Each person gets a private assistant. Phase 6 adds that; until then every new table still gets an owner column (rule 6). Shared team workspaces are not planned.
- **The mobile app** in `mobile/` keeps working but gets no new features until version 2.
- **Estimates** assume one developer working in this repo.

## Built

| Piece                                              | Code                                                                 |
| -------------------------------------------------- | -------------------------------------------------------------------- |
| Conversations: storage, streaming, stop            | `src/server/engine/thread-runner.ts`, `chat-routes.ts`               |
| Agent loop, turn modes and prompt (TanStack AI)    | `src/server/engine/index.ts`, `modes.ts`, `prompt.ts`                |
| Approvals, rules and "Always allow"                | `src/server/engine/approvals.ts`, `grants` and `grant_policies`      |
| Stops when stuck, with a blocked status            | `src/server/engine/stuck.ts`                                         |
| Connections: Gmail, Outlook, Teams and MCP servers | `src/server/connectors/`, [CONNECTIONS.md](CONNECTIONS.md)           |
| Event engine (accounts, MCP and webhook sources)   | `src/server/inbox/`                                                  |
| Discovery: triage with history                     | `src/server/discovery/`, [DISCOVERY.md](DISCOVERY.md)                |
| Memory: entities and the daily distill-and-prune   | `src/server/memory/`, [MEMORY.md](MEMORY.md)                         |
| Proposals: prepare, handle, not now                | `src/server/discovery/proposals.ts`, `proposal-store.ts`             |
| Routing, delivery and the morning brief            | `src/server/discovery/delivery.ts`                                   |
| Focus, mute, away and notes, with a Lift button    | `src/server/discovery/attention.ts`, `src/server/attention-tools.ts` |
| "These two items are the same thing"               | `link_inbox_items` in `src/server/attention-tools.ts`                |
| Offer to mute what you keep dismissing             | `attention_declined`, `src/server/discovery/proposal-store.ts`       |
| Waiting on others, with a follow-up draft          | `src/server/discovery/waiting.ts`                                    |
| Activity view                                      | `src/client/ActivityView.tsx`                                        |
| Approve several requests at once from the brief    | `src/client/InboxBrief.tsx`                                          |
| Dots that direct other Dots                        | [DELEGATION.md](DELEGATION.md)                                       |
| Run inspector, cost meter and audit                | **Insights**, `src/server/insight-routes.ts`, `usage-store.ts`       |
| Slack                                              | `src/server/channels/`                                               |
| Pages, schedules, calls, Dot computers, push       | `store.ts`, `workspace.ts`, `voice.ts`, `computer-*.ts`, `push.ts`   |
| Postgres (pgvector, pg_trgm), SQLite import        | `src/server/db/`, `npm run import-sqlite`                            |

The architecture rework is also done: Composio is removed and one Account, Grant and Connector model replaced it; turn modes live in one table; every thread comes from one factory; and discovery's `decide()` runs in three named steps on top of entities.

## Design rules

1. **Everything that happens is an event first.** A new mail, a message, a meeting change: each is written to `inbox_events` before anything acts on it.
2. **Jev makes judgments, code makes decisions.** Jev answers small typed questions; code maps the answers to what happens, so every outcome can be explained.
3. **Nothing acts without a level of permission you chose.** See [Autonomy levels](#autonomy-levels). The default is the lowest.
4. **Reuse the gates we already have.** Chat approvals, page review cards and push notifications. New features go through them.
5. **Read before write.** Each new source ships read-only first, then drafts, then actions.
6. **Every row belongs to a user.** A new table gets an `owner_id` and real foreign keys on the day it is created.
7. **Remember facts, not mail.** An item's facts go to its entities and the item is pruned after the retention window. Something that only closes a matter (a receipt that matches a debit) is not worth remembering. If the full text is needed later, the connector fetches it again.
8. **Extend what exists.** When a feature needs something close to what is already there, extend that. Do not build a second one beside it.

## How much the assistant may do

These are product decisions. Code enforces them; the model cannot change them.

| Group                      | Examples                                                               | How it runs                                                                        |
| -------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Does on its own            | Read connected accounts, judge items, remember facts, write drafts     | No question asked. Nothing leaves OpenDots or changes an account.                  |
| Asks first, can be allowed | File, label and move mail; calendar holds and reminders; create a task | Waits for your yes. "Always allow this" turns one kind into a rule you can remove. |
| Always asks, every time    | Send a mail or message; accept, decline or move a meeting; pay; delete | Waits for your yes each time. Can never be set to "Always allow".                  |
| Never                      | Follow instructions found in mail; change its own permissions or rules | Not possible from any turn.                                                        |

A yes can be a tap or, on a call, a spoken command. See 1.4.

## Build order

| Phase | Ships                              | Why now                                                            | Rough effort |
| ----- | ---------------------------------- | ------------------------------------------------------------------ | ------------ |
| 1     | Home and call                      | This is the product: you call it, it walks you through your day    | 5–6 weeks    |
| 2     | The shape of your day              | Calendar, promises and reminders make "today" complete             | 4–5 weeks    |
| 3     | It comes to you                    | A desktop app that reaches you when the window is closed           | 2–3 weeks    |
| 4     | A useful first five minutes        | Needed before anyone else tries it                                 | 2–3 weeks    |
| 5     | People and trust                   | Needs the decisions recorded in phases 1–4                         | 6–8 weeks    |
| 6     | Many users, and shipping version 1 | Sign-in and separate users, then installing it without a developer | 8–10 weeks   |
| Later | Version 1.x                        | Useful, but version 1 works without them                           |              |
| v2    | Mobile                             | After the desktop app is right                                     |              |

Each feature below says why it matters, what exists today, what to build, and how to tell it is done.

## Building in parallel

The phases are the order things matter in, not a strict queue. Much of the work does not depend on phase 1 and can be built beside it by separate agents. The waves below show what can run at the same time: everything in a wave can be built together, once the work it waits for is merged.

Phase 1 and the rest of wave 1 have build specs in [specs/](specs/README.md). Any other feature needs its spec written before an agent starts on it.

### Wave 1: start now, together

| Agent | Work                                                                                 | Mostly touches                                     |
| ----- | ------------------------------------------------------------------------------------ | -------------------------------------------------- |
| A     | 1.2 steps 1–2: the assistant setting and the top bar                                 | `src/client/App.tsx`, settings                     |
| B     | 1.1 step 1: `buildToday` and `GET /api/today`                                        | `src/server/today.ts`, `src/shared/today-types.ts` |
| C     | 1.2 step 3 and the route in step 4: tool risk, policy checks, `GET /api/permissions` | `src/server/connectors/`                           |
| D     | 2.1 Calendar as a source                                                             | `src/server/connectors/`, `src/server/inbox/`      |
| E     | 4.1 Look back 60 days                                                                | `src/server/inbox/account-source.ts`, memory       |
| F     | 6.8 Checks against the live services, then 6.9 Costs in money                        | CI, `usage-store.ts`, Insights                     |

C and D both work in the connector files: C adds a `risk` to each tool, D adds calendar tools. Merge C first, and D gives its new tools a risk.

### Wave 2: after A and B are merged

| Agent | Work                                                                     | Waits for | Mostly touches                             |
| ----- | ------------------------------------------------------------------------ | --------- | ------------------------------------------ |
| G     | 1.1 step 2: the home view and the item view                              | A, B      | new files in `src/client/`                 |
| H     | 1.2 step 4: the "What it may do" screen                                  | A, C      | `src/client/PermissionsView.tsx`           |
| I     | 1.4 steps 1 and 4: one `decideItem` function, and recording tap or voice | B         | approvals, proposals, one migration        |
| J     | 1.3 steps 1–2: the walk and the speech model's tools, server side        | B         | `src/server/voice.ts`                      |
| K     | 5.1 People and client pages                                              | A         | memory routes, a new client view           |
| L     | 3.2 Connection health                                                    | A         | connectors, delivery, the top bar's status |
| M     | 2.2 Meeting prep                                                         | D         | discovery delivery, memory                 |

### Wave 3: after G, I and J are merged

| Agent | Work                                                                    | Waits for | Mostly touches                                         |
| ----- | ----------------------------------------------------------------------- | --------- | ------------------------------------------------------ |
| N     | 1.3 steps 3–4: the call screen and the receipt                          | G, J      | `CallView.tsx`, `useVoice.ts`                          |
| O     | 1.4 steps 2, 3 and 5: the checks, approvals on a call, the confirmation | I, J      | `src/server/voice.ts`, `engine/modes.ts`               |
| P     | 2.3 What I owe                                                          | G         | `discovery/classifier.ts`, a new table, the home board |
| Q     | 2.4 Quick capture and reminders                                         | G         | a new inbox source, the home text box                  |
| R     | 3.1 The desktop app                                                     | G         | a new folder for the shell, push registration          |
| S     | 5.7 Drafts in your voice                                                |           | the drafting prompt, memory                            |

N and O both change the call. Give them to one agent, or merge N before O starts on the client side.

### Wave 4: after wave 3

| Agent | Work                                    | Waits for | Mostly touches                         |
| ----- | --------------------------------------- | --------- | -------------------------------------- |
| T     | 5.4 "Why this?" and "this is wrong"     | G         | the why templates, item view, findings |
| U     | 4.2 "What do you do, and what matters?" | P         | `discovery/classifier.ts`, attention   |
| V     | 2.5 End of day and the weekly review    | P, Q      | delivery, the home board               |
| W     | 5.2 "You haven't spoken in a while"     | K         | memory, proposals                      |
| X     | 5.5 Measure whether it is right         | I         | findings, Insights                     |

### Wave 5

| Agent | Work                               | Waits for | Mostly touches                   |
| ----- | ---------------------------------- | --------- | -------------------------------- |
| Y     | 4.3 Onboarding and the first brief | E, U      | a new first-run view             |
| Z     | 5.3 Suggestions beyond the inbox   | P         | a new inbox source, routing      |
| AA    | 5.6 Learned importance, then 5.8   | T, X      | `discovery/service.ts`, delivery |

### Last, and alone

Phase 6 changes every table and every store, so nothing else should be in flight.

1. One agent: 6.1, 6.4 and 6.5 together (owner columns, the push fix and foreign keys are one migration pass).
2. Then two agents: 6.2 Sign-in and 6.3 Background work per user.
3. Then two agents: 6.6 Install and updates, and 6.7 Your data, your control.

### Files only one agent should change at a time

| Files                                                 | Features that change them              | How to avoid a clash                                                                            |
| ----------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `src/server/db/migrations.ts`                         | Nearly all                             | Each agent appends one migration. Its version number is set when merging, as the next free one. |
| `src/client/App.tsx`                                  | 1.2 first, then anything adding a view | Merge A before any other client work. After that a new view is one line.                        |
| `src/server/discovery/classifier.ts` and `service.ts` | 2.3, 4.2, 5.4, 5.6, 5.8                | One at a time, in that order. The waves above already keep them apart.                          |
| `src/server/voice.ts`, `useVoice.ts`, `CallView.tsx`  | 1.3, 1.4                               | J, then N and O.                                                                                |
| `src/shared/inbox-types.ts`                           | 2.1, 2.3, 5.4                          | Add new types in a new file where possible.                                                     |

### Running several agents

- Give each agent its own git worktree and branch, and one piece of work from the tables.
- Merge one branch at a time. After each merge run `npm run typecheck`, `npm run lint` and `npm test` before merging the next.
- Three or four agents at once is a sensible limit. Each one's work still has to be reviewed, and reviewing is the slow part.

## Phase 1: home and call

### 1.1 Home: the assistant and today

- **Why:** a list of flagged items is not a plan, and the items that need you must be the first thing you see.
- **Today:** the Inbox has the brief, proposals and waiting on others as separate views. The app opens on a chat with a sidebar of Spaces and Dots.
- **Build:** a new home screen. On the left, the assistant: a call button, then the log of what it said, what you typed and a receipt for each call. On the right, the day laid out across the screen: up to two large "Needs you now" cards, then three columns for Decide, Waiting on others and Your day. Every card says why it is there. One endpoint, `GET /api/today`, builds the list in code from what is already stored.
- **Done when:** you can work a morning from this screen without opening the Inbox, and the two most urgent items are the first things you notice.
- **Effort:** 2 weeks.
- **Spec:** [specs/1.1-home.md](specs/1.1-home.md)

### 1.2 One assistant by default

- **Why:** Spaces, Dots, specialists and threads are too many ideas. You talk to one assistant.
- **Today:** discovery hands each item to the Dot named in discovery settings. Delegation exists through `ask_dot`. The sidebar lists every Space and Dot.
- **Build:** one Dot is marked as the assistant. It owns discovery, the brief, the home screen and calls. Navigation becomes a top bar with Today, Inbox and People. Spaces, other Dots, Activity, Insights and Accounts move into Settings and keep working.
- **Done when:** a new install never asks you to create or choose a Dot, and an existing install with several Dots keeps all of them.
- **Effort:** 1 week.
- **Spec:** [specs/1.2-one-assistant.md](specs/1.2-one-assistant.md)

### 1.3 Call it and talk through your day

- **Why:** this is the main way to use OpenDots. Talking through five items takes a few minutes and no reading.
- **Today:** calls exist (realtime speech, with an `ask_compute` tool that hands work to the Dot). A call is an open conversation; it does not know about today's items and the screen does not follow it.
- **Build:** a "walk through today" call. The server gives the call the ordered list from 1.1. The assistant reads one item, you decide, it moves to the next. The screen shows the item being discussed, what is up next and what was decided. The call ends with a receipt in the log.
- **Done when:** five waiting items can be cleared in one call without touching the mouse, and the log shows what was decided.
- **Effort:** 2 weeks.
- **Spec:** [specs/1.3-call-through-today.md](specs/1.3-call-through-today.md)

### 1.4 Spoken decisions

- **Why:** if the assistant reads a draft and you then have to find a button, the call is slower than the screen.
- **Today:** approvals can only be answered in chat, by a tap. A voice turn gets no approvals at all.
- **Build:** on a call, a spoken command decides the item on screen: "send it", "approve", "skip", "later", "not important", "change it to…". It works for every group, including sending. Code, not the model, runs the decision, and only for the item the call is on. The assistant gives a brief confirmation ("Sent to Thandi"). Each approval records how it was given, by tap or by voice.
- **Done when:** saying "send it" on a call sends exactly the draft on screen and nothing else, and Insights shows it was approved by voice.
- **Effort:** 1 week.
- **Spec:** [specs/1.4-spoken-decisions.md](specs/1.4-spoken-decisions.md)

## Phase 2: the shape of your day

### 2.1 Calendar as a source

- **Why:** "what should I do today" depends on what today looks like.
- **Today:** the Outlook connector can list calendar events as a tool. Google Calendar is not connected. The calendar is not read to plan anything.
- **Build:** add calendar read to the Gmail sign-in. Poll the next 14 days for both providers and write changes as `calendar.changed` events. Keep a small `calendar_events` table (owner, start, end, title, attendees, link) that is replaced on each poll, so nothing old is kept. Attendees are matched to entities with the free tiers.
- **Done when:** a meeting created in Outlook or Google appears in OpenDots within one poll, linked to the people in it.
- **Effort:** 1 week.

### 2.2 Meeting prep

- **Why:** most follow-ups start or end in a meeting.
- **Build:** before each meeting with someone outside your organisation, a short brief from memory: who they are, open items with them, what you owe them and what they owe you, and the last three things said. It is built from entity fact sheets, so it costs one model call and no new storage. It is delivered by the normal delivery rules, by default 30 minutes before.
- **Done when:** the prep for a test meeting names the open invoice and the unanswered question for that attendee.
- **Effort:** 3–4 days.

### 2.3 What I owe

- **Why:** discovery judges what arrives. Nothing tracks what you promised: "I'll send the quote by Friday".
- **Today:** Jev already reads the mail you send, to find what you are waiting on (`sent_item` in `src/server/discovery/classifier.ts`).
- **Build:** two more questions in that same call: does the owner promise to do something, and by when. A `commitments` table (owner, item, entities, what, due, state). A commitment closes when a later sent item delivers it, matched through entities, or when you mark it done. Before the due time the Dot offers to prepare it, as a proposal. A promise kept in the same message ("attached, as promised") is never recorded, following rule 7.
- **Done when:** a test thread where the owner writes "I'll send it Friday" produces a commitment due Friday, and sending the file closes it.
- **Effort:** 1–2 weeks.

### 2.4 Quick capture and reminders

- **Why:** if "remind me to call Sipho on Thursday" has to go in another app, OpenDots is not where your work lives.
- **Build:** a hotkey opens a one-line box. What you type becomes an inbox event from a new `capture` source, so it follows rule 1 and everything downstream works: entities, Today, delivery. Jev reads a due time from it with a typed question. Every item also gets **Remind me**: later today, tomorrow, next week or a date. Reminders reuse the snooze that proposals already have.
- **Done when:** a captured reminder appears in Today on its day and pushes at its time.
- **Effort:** 1 week.

### 2.5 End of day and the weekly review

- **Why:** closing the day is what makes the list trusted the next morning.
- **Build:** an evening summary from stored state: done, slipped, moved to tomorrow, still waiting on others. One tap moves the rest to tomorrow. On Friday, a week view of the same, plus what the assistant handled for you. Both are off during away.
- **Done when:** nothing from today is still marked "today" the next morning unless you chose to keep it.
- **Effort:** 3–4 days.

## Phase 3: it comes to you

### 3.1 The desktop app

- **Why:** an assistant that only speaks when a browser tab is open does not come to you.
- **Today:** a web app, and push to the mobile app.
- **Build:** a Tauri shell around the web client: a tray icon with a count of what is waiting, native notifications with the same action buttons as mobile push (approve, not now, open), start on login, and a global hotkey that starts a call or opens the capture box (2.4). A notification for an urgent item has a **Call now** button. The desktop app registers as a device, so the delivery rules, quiet hours and hold window apply unchanged. The server stays where it runs today; packaging it is 6.6.
- **Done when:** with the window closed, an urgent item raises a notification, and Approve on it sends the reply.
- **Effort:** 1–2 weeks.

### 3.2 Connection health

- **Why:** when a Gmail or Outlook sign-in expires, discovery stops without telling you. For an assistant you trust to watch things, that is the worst failure.
- **Today:** an expired sign-in is recorded on the account and shown in **Accounts**. Nothing tells you.
- **Build:** when an account moves to an error state, push "Reconnect Outlook" once, show a badge in the app, and add a line to the morning brief until it is fixed. Also warn when a source has returned nothing for far longer than is normal for it.
- **Done when:** revoking a sign-in in a test produces one push and one brief line, and reconnecting clears both.
- **Effort:** 3–4 days.

## Phase 4: a useful first five minutes

### 4.1 Look back 60 days when you connect

- **Why:** a new source looks back 24 hours, so the first day is nearly empty and memory knows nobody.
- **Today:** `FIRST_LOOKBACK_MS` in `src/server/inbox/account-source.ts` is 24 hours. Memory already distills old items for free, because Jev matching only runs for items from the last day.
- **Build:**
  1. Read 60 days of mail and messages on connect, in pages, in the background, newest first.
  2. Distill everything into entities with the free tiers only.
  3. Judge with Jev only items from the last 7 days, plus older threads where the last word was someone asking you for something. Show the number of Jev calls before starting, and let the user choose a shorter window.
  4. Never push for a backfilled item. Results go to the first brief (4.3).
  5. Items older than the retention window are distilled and pruned in the same pass, so the backfill leaves facts and not mail.
- **Done when:** ten minutes after connecting a real mailbox, memory lists the people and companies you deal with, and the Inbox shows what is still waiting on you.
- **Effort:** 1 week.

### 4.2 "What do you do, and what matters right now?"

- **Why:** vague items ("is this relevant to me?") need to know who you are. This is personal attention step 3 from the earlier roadmap.
- **Today:** notes exist as a memory kind, but discovery never reads them.
- **Build:** a first-run conversation that asks the question, then proposes entries you confirm one by one: a few facts about you ("I run a dev team", "I'm not running a business") and a first set of focus and mute entries. Confirmed facts are a new typed kind, `about`, capped at about five. Jev gets them as state for "does the owner need to look at this?". Free-form notes still never reach discovery.
- **Done when:** the same test item is flagged for a user whose facts make it relevant and not for one whose facts do not, and the finding says which fact decided it.
- **Effort:** 1 week.

### 4.3 Onboarding and the first brief

- **Why:** the first five minutes decide whether someone comes back.
- **Today:** a token gate and a generic setup card.
- **Build:** four steps: sign in, connect mail and calendar, answer 4.2, then watch the backfill fill in. It ends on a first brief: "12 things are waiting on you, 5 people owe you a reply, here are the 3 to do first". The user starts with one assistant (1.2), already set up, and the last step offers a first call.
- **Done when:** a new user reaches a first brief with real items without opening settings.
- **Effort:** 1 week.

## Phase 5: people and trust

### 5.1 People and client pages

- **Why:** before you reply to a client you want the whole picture in one place.
- **Today:** entities hold a fact sheet, aliases and edges. There is no view of them, only `search_memory` for the Dot and a merge route.
- **Build:** a **People** view: one page per person and company, with open items, what you owe, what they owe, last contact, the recent facts, and the people linked to a company. Merge, rename and "forget this" are on the page. It is a view of the memory tables and stores nothing new.
- **Done when:** opening a client shows every open item and commitment for them, and merging two entries moves their history.
- **Effort:** 1 week.

### 5.2 "You haven't spoken in a while"

- **Why:** some follow-ups have no mail to trigger them.
- **Build:** for people and companies you had regular contact with, code compares the gap since `last_seen_at` with their usual rhythm and raises a suggestion when it is well past. It only runs for entities you marked as a client or that are in an active focus, so it stays quiet by default.
- **Done when:** a client with weekly contact and six weeks of silence appears once as a suggestion, and "not now" keeps it away for a month.
- **Effort:** 3–4 days.

### 5.3 Suggestions beyond the inbox

- **Why:** deadlines also sit in pages, calendar invites and old threads.
- **Build:** an internal source that reads OpenDots' own tables on a timer and writes events: a date in a page that is close, a thread that stalled with a question open, an unpaid invoice past its due date, a commitment at risk. They become proposals with the usual prepare, handle and not now, and each says why it was suggested. These sources have no connected account, so the "may the Dot act" check takes the source and the action and no longer assumes an account.
- **Done when:** a page with "launch on the 14th" produces one suggestion three days before, and no duplicates after.
- **Effort:** 1–2 weeks.

### 5.4 "Why this?" and "this is wrong"

- **Why:** you forgive a wrong nudge if it explains itself and takes a correction.
- **Today:** findings store Jev's answers, and the app offers to mute what you keep dismissing.
- **Build:** on every item and proposal, a **Why** line built by code from the stored answers ("flagged: asks for a decision, needed today, about GreenBasket which you are focusing on"). A **Wrong** button with reasons: not important to me, not urgent, already handled, not for me. A reason can turn into a mute or a link straight away, with your yes. Jev's answers and the notes code adds are stored side by side, never merged, so the raw answer stays as Jev gave it.
- **Done when:** every flagged item can show its reason, and three "not important" answers on one kind of item produce a mute suggestion.
- **Effort:** 1 week.

### 5.5 Measure whether it is right

- **Why:** thresholds are still starting values. Without numbers, tuning is guesswork.
- **Build:** two numbers per user per week, shown in Insights:
  - **Acted on:** the share of flagged items you prepared, handled or replied to, against dismissed or ignored.
  - **Missed:** items it did not flag that you replied to or acted on yourself within a day.

  Every finding records the question set and thresholds it was judged with (`judged_by`), so results from different versions are never mixed.

- **Done when:** Insights shows both numbers and the list of misses behind them.
- **Effort:** 1 week.

### 5.6 Learned importance

- **Why:** urgency is about the item and is the same for anyone. Importance is about you.
- **Today:** importance is worked out from urgency and Jev's confidence (`importanceOf` in `src/server/discovery/proposals.ts`).
- **Build:** importance becomes its own stored score. Record what you do with each item: prepare, handle or reply raise it; dismiss lowers it; snooze and leaving it for days lower it slightly. Keep scores per kind of item, per person or company and per project, fading over time. Delivery uses urgency and importance together. Safety stays in code: fraud-like items and anything needed within hours are never lowered.
- **Done when:** after a user dismisses a sender's newsletters for two weeks, the next one goes to the Inbox only, and the **Why** line says so.
- **Effort:** 2 weeks.

### 5.7 Drafts in your voice

- **Why:** if every draft needs rewriting, "handle it" saves no time.
- **Build:** a small style profile per user, distilled from mail you sent: greeting, sign-off, usual length, how formal, and language, with an override per person where yours clearly differs. It is stored as a few facts, not as examples of your mail, and the drafting prompt gets it. When you edit a draft before sending, the difference is recorded and feeds the profile. The share of drafts sent without edits is a third number in 5.5.
- **Done when:** drafts to a close colleague and to a new client differ in greeting and length the way your own mail does.
- **Effort:** 1–2 weeks.

### 5.8 Smaller discovery work

- **Tune thresholds** on real items using 5.5. This sends mail text to TypeSafe with `TYPESAFE_API_KEY`, so each user agrees first.
- **Quieted senders before Jev.** A sender you quieted still costs one Jev call today. Check the rule first and skip the call, unless the item mentions an invoice, order or ticket that is still open.
- **One answer to "is this done?"** A finding, a proposal, a queued push and a waiting item each hold their own state. The finding becomes the one that decides, and the others follow it.
- **When Jev is unreachable:** items queue and are judged later, nothing is dropped, and after an hour the app and the brief say discovery is behind.
- The gaps listed at the end of [DISCOVERY.md](DISCOVERY.md).
- **Effort:** 1 week in total.

## Phase 6: many users, and shipping version 1

### 6.1 An owner on every table

- **Why:** each person's mail, memory and Dots must be invisible to everyone else.
- **Today:** `OWNER_ID` is one string for the whole install (`src/server/index.ts`). Accounts, OAuth states, threads and the memory tables carry an owner. Spaces, Dots, pages, schedules, inbox sources and items, findings, proposals, pushes, waiting items, the usage ledger and the attention entries do not. `settings` and `discovery_settings` hold one row for everyone.
- **Build:**
  1. A `users` table. A migration creates one user from the current `OWNER_ID` and gives every existing row to them.
  2. `owner_id` on every table that lacks it, with an index. `settings` and `discovery_settings` become one row per user.
  3. Every store takes the user it works for, and every query filters on it. Routes read the user from the session (6.2), never from the request body.
  4. `owner_id` is stored once per thread, on `thread_bindings`; `conv_threads` reads it from there.
- **Done when:** a test creates two users, fills both with data, and proves that no route, tool or background job returns one user's rows to the other.
- **Effort:** 2 weeks.

### 6.2 Sign-in

- **Why:** one shared `OWNER_TOKEN` cannot tell people apart or be taken away from one device.
- **Today:** one bearer token checked in one place (`src/server/app.ts`).
- **Build:** sign in with Google or Microsoft, which most users connect anyway, and passkeys as a second step. A `sessions` table with one row per signed-in device, an expiry, and a list in settings where you can sign a device out. `OWNER_TOKEN` stays for local development only.
- **Done when:** two people sign in on one install and each sees only their own data; signing a device out ends its session at once.
- **Effort:** 1–2 weeks.

### 6.3 Background work per user

- **Why:** discovery, memory, schedules and the brief assume one owner.
- **Today:** `DiscoveryService`, `MemoryService`, the waiting-on-others check and the morning brief each run once for the install. Pausing OpenDots pauses everyone.
- **Build:** each job loops over users, with that user's settings, quiet hours, time zone and token limits. Pause becomes per user. One user's failing source must not stop the next user's run.
- **Done when:** two users in different time zones each get their own morning brief at their own time.
- **Effort:** 1 week.

### 6.4 Push only reaches your own devices

- **Why:** this is a bug today. `push_devices` has no owner, so every registered device gets every push.
- **Build:** `owner_id` on `push_devices`, set from the session when a device registers. `src/server/push.ts` sends only to the devices of the user the push is for.
- **Done when:** a test registers two users' devices and a push for one reaches only theirs.
- **Effort:** 1 day, with 6.1.

### 6.5 Foreign keys

- **Why:** "delete my data" and pruning are only safe when the database removes the dependent rows.
- **Today:** only the connector and memory tables use `REFERENCES`. Elsewhere a relationship is a text column that matches by convention.
- **Build:** add foreign keys with `ON DELETE CASCADE` as part of 6.1, table by table: a finding, proposal, push and waiting item to their inbox item; pages to Spaces; threads, runs and events to their thread; everything to `users`. Remove orphaned rows first in the same migration.
- **Done when:** deleting a user removes every row they own, and a test proves it by counting.
- **Effort:** 3–4 days, with 6.1.

### 6.6 Install and updates

- **Why:** Node, Postgres, Docker Compose and a hand-edited `.env` are a developer setup.
- **Build:** two ways to run it, from one codebase:
  - **Hosted:** one server for many users, which 6.1 to 6.5 make possible. The desktop app from 3.1 signs in to it.
  - **Self-hosted:** one Compose file with the app and Postgres, and a setup page that checks each key and connection and says what is wrong. Dot computers stay an optional extra, since they need Docker.

  The desktop app updates itself and shows what changed.

- **Done when:** someone who is not a developer goes from download to first brief without a terminal.
- **Effort:** 2 weeks.

### 6.7 Your data, your control

- **Build:** export everything as one archive; delete your account and every row with it, which 6.5 makes safe; choose the retention window; automatic database backups for self-hosters. Connection secrets are already encrypted (`src/server/connectors/secrets.ts`); check every other stored secret the same way.
- **Done when:** an export can be read without OpenDots, and after a delete no row with that user's id remains.
- **Effort:** 1 week.

### 6.8 Checks against the live services

- **Why:** tests run on fixtures. Slack and spoken delegation have never been verified live, and chat was last verified before the engine changed.
- **Build:** a scheduled job, kept out of pull requests, that runs one real turn per provider with test accounts: the model, Gmail, Outlook, Teams, Slack and TypeSafe. A release checklist for calls and Dot computers.
- **Done when:** a broken provider integration is caught by the job before a release.
- **Effort:** 3–4 days.

### 6.9 Costs in money

- **Build:** a price per model, so Insights shows what each Dot and each user cost this month in rand or dollars, with a warning before a cap. Jev calls are counted too.
- **Effort:** 2–3 days.

## Later: version 1.x

Not scheduled. Pick from here when the build order has room.

| Feature                    | Plan                                                                                                                                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File attachments           | Drop a PDF, image or spreadsheet into chat. Investigations read mail attachments through the connector, where most invoices and contracts arrive. Text is read when needed and not stored.         |
| Search everything          | One box across chats, pages, inbox items and people. Starts from entities and `pg_trgm`; embeddings are added per kind only where exact and near matches are not enough.                           |
| Automations in plain words | "When an invoice from X arrives, file it and tell me." A listener on the inbox engine that uses the same matcher as mute and focus, so there is one way to say "items like this".                  |
| Undo                       | Autonomy level 3. It is its own mechanism: the action runs, then a time window allows a reversal. It is not an extension of approvals, which decide before anything runs.                          |
| Meetings as a source       | Transcripts from Teams and Google Meet become events. Action items become commitments (2.3) or waiting items.                                                                                      |
| Tickets as a source        | One ticket system first; see open questions.                                                                                                                                                       |
| Learning                   | A nightly job groups finished threads by task, drafts a skill for your review, and loads approved skills through `load_skill`. It needs months of decisions and the `judged_by` versions from 5.5. |
| Starter Dots               | Ready-made Finance, Dev team lead and Personal errands specialists the chief of staff can hand work to.                                                                                            |

## Version 2: mobile

| Feature           | Plan                                                                                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared code first | `mobile/src/lib` is a hand-made copy of `src/shared`. Make the repo an npm workspace so both apps import the same files, before any version 2 feature is written. |
| Parity            | Today, People, Activity, rules and sign-in on the phone. Pages need a decision: a web view around the editor, or a simpler native one.                            |
| Share sheet       | "Send to my Dot" from any app, into the capture source from 2.4.                                                                                                  |
| Widget            | Today's top three on the home screen.                                                                                                                             |
| It reaches you    | WhatsApp and SMS as channel adapters next to Slack. A phone call for something urgent is a separate piece of work, with its own consent and cost.                 |

## Not planned

Shared Spaces, shared page editing, invitations and group conversations with several Dots. OpenDots is a private assistant for each user.

## Autonomy levels

Set per source, per action type, and optionally per rule. Defaults are the lowest level.

| Level | Name            | What the Dot may do                                         |
| ----- | --------------- | ----------------------------------------------------------- |
| 0     | Notify          | Tell you something happened                                 |
| 1     | Prepare         | Read, research, write pages and drafts inside OpenDots      |
| 2     | Act on approval | Any action, but each write waits for **Approve & run**      |
| 3     | Act and report  | Act, then tell you what it did, with an undo where possible |

Levels 0 to 2 are built. Level 3 waits for undo. Sending, meeting changes, payments and deletes never go above level 2 in version 1; see [How much the assistant may do](#how-much-the-assistant-may-do).

## Security and privacy

- Mail, messages and tickets are **untrusted input**. A mail that says "forward all invoices to..." is data, never an instruction. Tools that change what discovery does (`save_attention`, `link_inbox_items`) only exist in chat turns with you, never in investigations.
- One user's data is never visible to another. Phase 6 enforces this in the database and proves it with tests.
- Raw mail is kept for the retention window, 14 days by default. After that only entity facts remain, so a leaked backup holds "you deal with Acme on invoices" and not the invoices.
- Connection secrets are encrypted in Postgres. Protect the database and its backups.
- Outside calls go to the model provider, TypeSafe for Jev's judgments, and the sources themselves. Nothing else leaves the server.
- Every outside action is recorded in the audit view (**Insights**).

## Open questions

- **Should the assistant call you?** Not in version 1. An urgent item raises a notification with a **Call now** button, so you start the call. Ringing you unasked needs its own rules (when, how often, how to refuse), and is easier to judge after using calls daily.
- **Hosted, self-hosted or both for version 1?** The plan in 6.6 assumes both. Hosted only would remove the installer work.
- **How much mail may the first backfill send to Jev?** 4.1 proposes 7 days by default, with the count shown first.
- **A fallback for Jev?** Every judgment depends on TypeSafe. 5.8 covers an outage by queueing. A second judge for long outages is not planned yet.
- **A wake word?** Starting a call by saying a name, without a click or the hotkey. Not planned; the hotkey in 3.1 covers it for now.
- **Passkeys in version 1, or Google and Microsoft sign-in only?**
- **Which ticket system comes first as a source,** and does it have an MCP server or an API token we can use?
