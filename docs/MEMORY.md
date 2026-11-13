# Memory

Discovery reads every item as it arrives. Memory keeps what each item said, so the item's full text doesn't have to be kept forever. Each real thing an item mentions gets an **entity**: a person, company, project, place, invoice, order or ticket. Its fact sheet is a list of what items said about it, newest first. Once an item's facts are in its entities, the item can be removed after the retention window (14 days by default, `retentionDays` in discovery settings).

## Tables

All rows belong to one owner (`owner_id`). An item's owner is the user of its connected account, or the install's owner for sources with no account, such as webhooks.

| Table                | What it holds                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `entities`           | One per real thing: kind, name, how many items mentioned it, first and last seen, and up to 20 facts. Each fact is a JSON object.                      |
| `entity_aliases`     | Every name and identifier an entity goes by, for exact lookup: an address, a domain, `INV-2041`, "thandi nkosi". One entity per owner, family and key. |
| `entity_edges`       | `works_at` (a sender to their domain's company) and `mentioned_with` (things in the same item), with a count of items.                                 |
| `event_entity_links` | Which item mentioned which entity, and how it was matched. Pruned with the item.                                                                       |
| `memory_runs`        | One line per local day: items noted, items cleared, things remembered.                                                                                 |

A fact records the item's date, app, sender, title, any amounts, what discovery made of it, and its link and external id. After the item is cleared, the link opens it in its app, or a connector can fetch it again.

## Matching, cheapest first

1. **Exact alias** (free): any name or identifier already known.
2. **Structure** (free): the sender's address, then their display name, is a person. Their domain is a company, unless it is a mailbox provider or one of the owner's own domains. The owner never becomes an entity.
3. **Near spelling** (cheap): a project, place or name spelled like exactly one known entity, with trigram similarity 0.8 or more, is that entity.
4. **Jev** (paid): other near spellings, and senders who write from a new address under a name like a known one, go to the same `match` question discovery uses. That's at most 3 per item, and only for items received in the last day, so the first backfill of existing mail costs nothing.
5. **The owner** merges two entities that are one thing (`POST /api/memory/entities/:id/merge`).

Invoices, orders and tickets are only ever matched exactly. `INV-2041` and `INV-2014` are different invoices. An address or domain in the text only joins an entity that already exists. A plain capitalised name becomes an entity only once a second item mentions it; projects and places always do.

**Tier 0:** an item discovery found closes an earlier one ("ignore my last mail") gets no entities of its own. Its fact, marked "closed an earlier item", goes to the earlier item's entities.

## The daily run

`MemoryService` (`src/server/memory/service.ts`) runs every 15 minutes:

- **Distill** every item that is ready. Items from judged sources wait for discovery's verdict, or an hour. Each item is written in one transaction that also sets `inbox_events.distilled_at`, so an item is never half-remembered.
- **Once per local day:** prune items received before the retention window, then write the day's line. The morning brief adds that line to its push.

Pruning removes an item only if it is distilled and nothing still waits on the owner: no flagged or investigating finding, no open choice and no queued push. It takes the item's entity links, links to other items and finding with it. The 2,000-items-per-source cap stays as a safety net for a source that floods, and follows the same rules.

Nothing runs while OpenDots is paused.

## Discovery reads it

Discovery gathers each new item's history from memory ([DISCOVERY.md](DISCOVERY.md#1-gather-find-every-earlier-item-this-could-relate-to)):

- Before judging, it distills every earlier item that isn't in memory yet, even one that arrived a minute ago.
- It matches the new item to known entities the same way, without writing anything. The new item itself is distilled later, after its verdict, so its facts carry the outcome and an item that only closed an earlier one adds nothing new.
- Every earlier item in those entities' facts is a candidate, including pruned ones.
- When an item says an earlier one no longer needs the owner, every other open item about the same invoice, order or ticket closes with it, subject to the same sender rule.

## Using it

- Dots have `search_memory`: everything known about a person, company, project or invoice, with recent facts and related things.
- `GET /api/memory/entities?q=&kind=` and `GET /api/memory/entities/:id` list and read entities. `GET /api/memory/runs` lists the daily lines.

## Not built yet

- A running total per entity (for example, spend per vendor).
- A screen for browsing and merging entities. The Inbox **Links** tab shows entities and their items, but can't merge them.
- Per-entity embeddings, for items that share no name, identifier or sender.
