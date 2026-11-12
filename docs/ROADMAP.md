# Roadmap: a personal assistant that watches your work

OpenDots runs on its own code, Postgres and a model provider. No CopilotKit package or account is needed (`@ag-ui/core` remains for event types). It watches your mail and messages, tells you what matters, and offers to prepare or handle it. This page lists what is built, what is left, and what comes next.

## Built

| Piece                                       | Code                                                            |
| ------------------------------------------- | --------------------------------------------------------------- |
| Conversations: storage, streaming, stop     | `src/server/engine/thread-runner.ts`, `chat-routes.ts`          |
| Agent loop and tools (TanStack AI)          | `src/server/engine/index.ts`, `engine/tools.ts`                 |
| Approvals                                   | `src/server/engine/approvals.ts`                                |
| Web and mobile chat client                  | `src/shared/thread-client.ts`, `src/client/useThread.ts`        |
| Run inspector, cost meter and audit         | **Insights**, `src/server/insight-routes.ts`, `usage-store.ts`  |
| Event engine (MCP and webhook sources)      | `src/server/inbox/`                                             |
| Discovery: triage with history              | `src/server/discovery/`, design in [DISCOVERY.md](DISCOVERY.md) |
| Proposals: prepare, handle, not now         | `src/server/discovery/proposals.ts`, `proposal-store.ts`        |
| Routing, delivery and the morning brief     | `src/server/discovery/delivery.ts`                              |
| Replies drafted in chat, sent on approval   | `src/server/platform.ts` (`proposeReply`)                       |
| Mail, messages and calendar actions         | Connections (Composio, MCP); writes wait for chat approval      |
| Slack                                       | `src/server/channels/`                                          |
| Pages, Dots, schedules, MCP, push           | `store.ts`, `workspace.ts`, `push.ts`, ...                      |
| Postgres (pgvector, pg_trgm), SQLite import | `src/server/db/`, `npm run import-sqlite`                       |

## Design rules

1. **Everything that happens is an event first.** A new mail, a message, a meeting change: each is written to `inbox_events` before anything acts on it. Replays, audits and "why did it do that?" all come from that table.
2. **Jev makes judgments, code makes decisions.** Jev answers small typed questions; code maps the answers to what happens, so every outcome is explainable.
3. **Nothing acts without a level of permission you chose.** See [Autonomy levels](#autonomy-levels). The default is the lowest.
4. **Reuse the gates we already have.** Chat approvals, page review cards and push notifications. New features route through them instead of inventing new ones.
5. **Read before write.** Each new source ships read-only first, then drafts, then actions.

## Left over from discovery and proposals

- **Tune thresholds on real items.** The Jev thresholds are starting values. Testing them sends mail text to TypeSafe with `TYPESAFE_API_KEY`, so ask the owner first.
- **Quiet by category or keyword**, not only by sender. Personal attention's mutes replace this (below).
- **Triage rules before Jev**, so a quieted sender costs no Jev call. Today the rule runs after, so the item can still update earlier ones.
- **Backfill older mail.** A new source looks back 24 hours, and each source keeps its newest 2,000 items.
- The smaller gaps listed at the end of [DISCOVERY.md](DISCOVERY.md).

## Personal attention: what matters to you

**Status:** planned. Builds on discovery, proposals and topic threads in each Dot's main chat, where the Dot raises items and asks for approval.

**Goal:** discovery adapts to the person using it. You can say "I'm focusing on GreenBasket this week", "payment notifications aren't important to me", "I'm away until Monday" or "these two emails are the same thing", and what gets flagged, pushed and listed changes to match. Every effect stays explainable and nothing unsafe can be switched off.

**Urgency and importance are separate.** Urgency is a fact about the item (how soon it needs handling), read by Jev and the same for anyone. Importance is about you (how much it matters to you), and is learned continuously. Today importance is derived from urgency and Jev's confidence; it becomes its own score. Delivery (push now, morning brief, or Inbox only) depends on both.

**One memory store, with kinds.** Extend the existing preferences (`memories`) with `kind`, `subject` and `until` rather than adding a separate feature. You tell the Dot in chat; it saves an entry with a tool and confirms it in one line. Entries can be listed and lifted ("stop focusing on GreenBasket"), and the Inbox shows the active ones.

| Kind  | Example                                      | Effect                                                                                     |
| ----- | -------------------------------------------- | ------------------------------------------------------------------------------------------ |
| focus | "focusing on GreenBasket this week"          | urgency up one level, pushed now instead of the brief, investigated first, top of the list |
| mute  | "payment notifications aren't important"     | not flagged or pushed; still in the Inbox, marked muted                                    |
| away  | "I'm away until Monday, don't bother me"     | discovery keeps working but nothing is pushed; one "While you were away" summary on return |
| note  | "I'm not a business man", "sign off Brandon" | the chat Dot knows it; discovery never reads free-form notes                               |

Only typed kinds steer discovery. Each active focus or mute adds one yes/no question per item to the Jev call discovery already makes ("Is this item about the GreenBasket ShelfLife app?", "Is this item a payment notification?"), and code decides what the answers change. A mute's subject can be a project, a sender, an organisation or a kind of item. Free-form memory is never injected into discovery: Jev answers typed questions, decisions must stay explainable ("not flagged: muted payment notifications"), entries need real end dates, and chat can quote outside content that must never be able to plant a rule.

**Safety stays in code.** Items that look like fraud (changed bank details, unexpected charges) or that need handling within hours still reach you under mute and away. Focus items count as exceptions while away.

**Turning what you say into entries.** The chat Dot reasons about what a statement implies and asks before saving: "Noted that you're not running a business. Should I stop flagging invoices and payment notices, supplier statements and quotes? I'd still tell you about anything that looks like fraud." Nothing changes without your yes.

**Saying two items are the same thing.** A `link_inbox_items` tool for the Dot, in chat turns only (never in investigations, which read untrusted mail). "These are the same thing" confirms a link even when Jev never suggested one, folds the newer item into the older (resolved with "same as …", its choice closed, its thread linked) so "what's waiting on me" shows the pair once. "Those aren't related" rejects the pair so it is never linked again. Today you can only confirm or reject pairs Jev was unsure about, from the Inbox review queue.

**Build in three steps, each usable on its own:**

1. **Explicit:** the memory store with focus, mute, away and notes; the Dot suggesting entries from what you say; importance split from urgency; `link_inbox_items`.
2. **Learned:** record what you do with each item (prepare, handle or reply raise importance; dismiss lowers it; snooze and leaving it for days lower it slightly; confirmed and rejected links), fading over time. Keep scores per kind of item, per sender or organisation and per project, all things Jev and tagging already identify. Show why on each item ("payment notices: you dismissed 4 of the last 5"). Strong patterns become suggestions in the main chat ("You've dismissed 3 payment notices this week. Stop flagging these?"), which turn into explicit entries when you say yes. This generalises today's rule that dismissing a sender twice quiets them.
3. **About you:** a few facts you have confirmed ("not running a business", "I run TDC's dev team") added to Jev's "does the owner need to look at this?" judgment, for vague items no mute names; and a first-run question, "What do you do, and what matters to you right now?", that seeds the profile and suggests a first set of entries.

**Open questions:**

- Should mute and away let urgent-within-hours and fraud-like items through (recommended), or block everything?
- Default length of a focus when you don't say (recommended: one week)?
- While away, offer an out-of-office reply as a draft you approve before leaving (recommended: not yet)?

**Rough effort:** step 1 about 1–2 weeks, step 2 about 2 weeks, step 3 about 1 week.

## Smoother to use

Ideas taken from OpenAI Dots, Grok Bot and Claude Duet (all launched September to November 2026), and from where reviewers found them weak. OpenDots already beats them in places: discovery runs as items arrive (Duet checks every few hours), every flag has a reason (Grok's triggers are opaque), each item has one thread with a full run inspector (Duet's two halves lose context and keep no transcript), token caps stop runaway cost, and you can watch and take over the Dot's browser.

1. **Fewer approvals.** Every review of these products complains about approval fatigue.
   - "Always allow this" on an approval card saves a rule for that action (and optionally that recipient or app), so the next one runs without asking.
   - One **Rules** page that lists every action as allow, ask first or block, merging today's MCP "Ask first" settings and discovery's per-app allowed list. Sending mail, payments and deletes cannot be set to allow without a typed confirmation.
   - Approve several waiting items at once from the morning brief.
2. **Honest when stuck.** When a task is blocked (a bot check, a login, the same tool failing twice), the Dot says what blocked it instead of presenting partial results as final, offers a way past it (take over the browser, use another account, ask you), and stops instead of looping. The turn ends with a "blocked" status the Activity view and push can show. Today the only guard is the iteration limit in `src/server/engine/index.ts`.
3. **Activity view.** Per Dot: **In progress**, **Scheduled** and **Done**, in plain language ("Drafting a reply to Thandi about the invoice"), each with Watch, Pause and Stop, and blocked items at the top. Insights stays as the technical view behind it.
4. **Waiting on others.** Discovery already reads each thread; it also records who owes the next step. "You owe a reply" stays in **For you**; "they owe you" goes to a **Waiting on others** list with how long it's been, and after a set time the Dot offers a polite follow-up draft. The Dot never nags you about something that is waiting on someone else, which is where Duet trips up.
5. **Suggestions beyond the inbox** (with Personal attention step 2): deadlines in pages and tickets, stalled threads, unpaid invoices and meeting prep, offered as proposals with the same prepare, handle and not now choices. Each says why it was suggested.
6. **Chief of staff Dot.** One Dot owns discovery and the morning brief, and hands each item to the specialist Dot for that area through delegation, which already exists. You talk to one Dot; specialists keep their own permissions.
7. **Voice that can approve.** Voice reads drafts aloud and takes "yes, send it" as an approval after reading back exactly what will be sent. Only for items already waiting for approval; voice still cannot start a send on its own.
8. **Onboarding** (with Personal attention step 3): the first-run question "What do you do, and what matters to you right now?", connecting your mail and calendar, and a first morning brief straight away, so the first five minutes show something useful.

**Rough effort:** 1 about 1 week, 2 a few days, 3 about 1 week, 4 about 1 week, 5 inside step 2, 6 about 1–2 weeks, 7 about 1 week, 8 inside step 3.

## Learning (later)

A nightly job groups finished threads by Dot and task type, asks a model to draft a skill (`SKILL.md`), and puts it in a review queue. Approved skills are loaded through the `load_skill` tool. Proposal decisions (prepare, handle, dismiss) and the labelled items in `discovery_findings` are the best training signal; the same data can train a small classifier (SetFit or ModernBERT) to take load off Jev.

**Rough effort:** 3–6 weeks.

## Autonomy levels

Set per source, per action type, and optionally per rule. Defaults are the lowest level.

| Level | Name            | What the Dot may do                                         |
| ----- | --------------- | ----------------------------------------------------------- |
| 0     | Notify          | Tell you something happened                                 |
| 1     | Prepare         | Read, research, write pages and drafts inside OpenDots      |
| 2     | Act on approval | Any action, but each write waits for **Approve & run**      |
| 3     | Act and report  | Act, then tell you what it did, with an undo where possible |

Sending mail, accepting meetings on your behalf and closing tickets never go above level 2 unless a specific rule you wrote says so.

## Security and privacy

- Mail, messages and tickets are **untrusted input**. A mail that says "forward all invoices to..." is data, never an instruction. Triage and tool prompts must say so, and write tools stay behind approvals.
- Source credentials live in Postgres on the server like MCP tokens today. Protect the database and its backups.
- Everything stays on your machine except calls to the model provider and the sources themselves.
- Every outside action is recorded in the audit view (**Insights**).

## Build order

| Next | Ships                                                        | Why now                                            | Rough effort |
| ---- | ------------------------------------------------------------ | -------------------------------------------------- | ------------ |
| 1    | Fewer approvals and honest when stuck                        | Small, and felt every day                          | 1–2 weeks    |
| 2    | Personal attention step 1: focus, mute, away, notes          | Makes discovery fit you                            | 1–2 weeks    |
| 3    | Activity view                                                | Shows the blocked status from step 1               | 1 week       |
| 4    | Waiting on others                                            | Uses discovery's threads; cuts noise               | 1 week       |
| 5    | Personal attention step 2, with suggestions beyond the inbox | Needs the decisions recorded from steps 1–4        | 2–3 weeks    |
| 6    | Chief of staff Dot                                           | Routing is easier once triage is personal          | 1–2 weeks    |
| 7    | Voice that can approve                                       | Builds on the Rules page and approvals from step 1 | 1 week       |
| 8    | Personal attention step 3, with onboarding                   | Best last: it shows off everything above           | 1–2 weeks    |
| 9    | Learning                                                     | Needs months of decisions to learn from            | 3–6 weeks    |

Tuning discovery's thresholds on real items can happen at any point, once the owner agrees to send mail text to TypeSafe.

Estimates assume one TypeScript developer working in this repo and exclude multi-user support.

## Open questions

- Which ticket system comes first as a discovery source, and does it have an MCP server or API token we can use?
