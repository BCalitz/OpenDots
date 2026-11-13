/** Event engine (roadmap phase 3): outside activity as normalized events. */
export type SourceKind = 'ticket' | 'mail' | 'message' | 'calendar';
export type InboxPriority = 'low' | 'normal' | 'high' | 'urgent';
export type InboxEventState = 'new' | 'seen' | 'dismissed';
/** When a new event sends a push notification. */
export type InboxNotify = 'off' | 'urgent' | 'high' | 'all';
export interface McpSourceConfig {
  dotId: string;
  /** The connected account, which this Dot must have a grant for. */
  accountId: string;
  /** The real tool name on that account. */
  tool: string;
  /** Tool arguments. The string "{{since}}" becomes the last poll time. */
  arguments: Record<string, unknown>;
  /** Optional dot paths into each item; sensible field names are tried otherwise. */
  fields?: Partial<
    Record<
      'items' | 'id' | 'title' | 'summary' | 'priority' | 'url' | 'from' | 'at',
      string
    >
  >;
}
/**
 * Discovery on a connected account (Gmail, Outlook or Teams): new items are
 * read on a timer, a small model flags the ones that need attention, and
 * `dotId` investigates them read-only.
 */
export interface AccountSourceConfig {
  dotId: string;
  /** The account's owner; its tools are read as this user. */
  userId: string;
  accountId: string;
  /** The account's connector, one of DISCOVERY_APPS. */
  app: string;
}
export type SourceType = 'mcp' | 'webhook' | 'account';
export type SourceConfig =
  McpSourceConfig | AccountSourceConfig | Record<string, never>;
export interface InboxSourceView {
  id: string;
  name: string;
  kind: SourceKind;
  type: SourceType;
  enabled: boolean;
  notify: InboxNotify;
  intervalSeconds: number;
  config: SourceConfig;
  hasSecret: boolean;
  lastPolledAt: number | null;
  nextPollAt: number | null;
  lastError: string | null;
  eventCount: number;
  newCount: number;
  createdAt: number;
}
export interface InboxEventView {
  id: string;
  sourceId: string;
  sourceName: string;
  externalId: string;
  kind: string;
  title: string;
  summary: string;
  priority: InboxPriority;
  from: string | null;
  url: string | null;
  occurredAt: number;
  receivedAt: number;
  state: InboxEventState;
  /** Set once discovery has looked at the event. */
  finding?: FindingView | null;
}
/**
 * - ignored: the discovery model saw nothing that needs the owner.
 * - flagged: it needs attention; waiting for a Dot to investigate.
 * - investigating: a Dot is looking into it, read-only.
 * - ready: the Dot's findings and proposal are in `threadId`.
 * - failed: the investigation did not finish; see `error`.
 * - resolved: a later item said it no longer needs the owner.
 */
export type FindingState =
  'ignored' | 'flagged' | 'investigating' | 'ready' | 'failed' | 'resolved';
/** How soon an item needs handling, as Jev read it. */
export type Urgency = 'days' | 'tomorrow' | 'today' | 'hours';
export const URGENCIES: Urgency[] = ['days', 'tomorrow', 'today', 'hours'];
/** What an item asks of the owner. */
export type Asked = 'nothing' | 'information' | 'reply' | 'action' | 'decision';
/**
 * What the Dot does with a flagged item, decided in code from what is asked
 * and what the owner allows:
 * - tell: only tell the owner; no investigation.
 * - draft: investigate and draft a reply for the owner to send.
 * - propose: investigate and propose an action the owner approves.
 * - inform: an action the Dot can't or may not do; say what, where and who.
 * - decide: gather the facts and options; propose nothing.
 */
export type Route = 'tell' | 'draft' | 'propose' | 'inform' | 'decide';
/** When the owner hears about it: now, after the hold window, in the
 * morning brief, or not at all. */
export type Delivery = 'now' | 'held' | 'brief' | 'none';
/** An earlier item found to be about the same thing. */
export interface EventLinkView {
  eventId: string;
  otherEventId: string;
  /** 0 to 1, from Jev's "same thing?" score. */
  score: number;
  status: 'linked' | 'review' | 'confirmed' | 'rejected';
  createdAt: number;
  /** The item itself (`eventId`) and the one it links to; null once pruned. */
  item: { title: string; from: string | null; occurredAt: number } | null;
  other: { title: string; from: string | null; occurredAt: number } | null;
}
export interface FindingView {
  id: string;
  eventId: string;
  attention: boolean;
  /** What the item is, such as payment or meeting. */
  category: string;
  /** 0 to 1, as reported by the discovery model. */
  confidence: number;
  reason: string;
  /** The model that judged it, or "rules" when no model was needed. */
  judgedBy: string;
  state: FindingState;
  dotId: string | null;
  threadId: string | null;
  /** Set when this item reads as referencing an earlier one from the same
   * sender and asking for an action. */
  referencedEventId: string | null;
  error: string | null;
  urgency: Urgency | null;
  asked: Asked | null;
  /** The item reads as instructing an AI assistant. */
  injection: boolean;
  route: Route | null;
  delivery: Delivery | null;
  /** Something a later item said, such as "X says this can be ignored". */
  note: string | null;
  createdAt: number;
  updatedAt: number;
}
export interface InboxState {
  sources: InboxSourceView[];
  events: InboxEventView[];
}

/**
 * What a tag identifies. project, place and name are free-form: any
 * recurring name, typed by a cue word ("Project Falcon", "Cape Town
 * office") or left as a plain name. They link on the name alone, and only
 * names found in two or more items are shown.
 */
export type TagKind =
  | 'invoice'
  | 'order'
  | 'ticket'
  | 'amount'
  | 'email'
  | 'domain'
  | 'person'
  | 'project'
  | 'place'
  | 'name';
/** An item on the links view. Pruned items are shown from their facts. */
export interface LinkItem {
  id: string;
  sourceId: string;
  sourceName: string;
  sourceKind: SourceKind | null;
  title: string | null;
  from: string | null;
  occurredAt: number;
  flagged: boolean;
}
/** One remembered entity and every item that mentions it. */
export interface LinkTag {
  kind: TagKind;
  /** Its key: an invoice number, an address, a name in lower case. */
  normalized: string;
  /** Its name, as written. */
  value: string;
  itemIds: string[];
}
/** Two entities of one kind whose names are spelled alike (pg_trgm). */
export interface SimilarTags {
  kind: TagKind;
  a: string;
  b: string;
  similarity: number;
}
export interface LinksState {
  items: LinkItem[];
  tags: LinkTag[];
  similar: SimilarTags[];
}

/** Apps discovery can read, with what their items are. */
export const DISCOVERY_APPS: Record<
  string,
  { name: string; kind: SourceKind }
> = {
  gmail: { name: 'Gmail', kind: 'mail' },
  outlook: { name: 'Outlook', kind: 'mail' },
  teams: { name: 'Microsoft Teams', kind: 'message' },
};
/** Discovery settings for one connected account. */
export interface DiscoveryAccountView {
  sourceId: string;
  accountId: string;
  app: string;
  dotId: string;
  enabled: boolean;
  intervalSeconds: number;
  lastPolledAt: number | null;
  lastError: string | null;
}
export interface DiscoveryState {
  accounts: DiscoveryAccountView[];
  /** Whether Jev (TYPESAFE_API_KEY) is set up to decide what needs attention. */
  model: { configured: boolean };
  settings: DiscoverySettings;
}
/** When and how discovery reaches the owner, and what Dots may do. */
export interface DiscoverySettings {
  /** Local time of the morning brief, "HH:MM". */
  briefTime: string;
  /** No pushes except "within hours" between these local times; null for none. */
  quietHours: { start: string; end: string } | null;
  /** Minutes a non-urgent push waits, so a quick follow-up can cancel it. */
  holdMinutes: number;
  /** IANA time zone for the brief and quiet hours. */
  timeZone: string;
  /**
   * The owner's own addresses and organisation domains. Besides the
   * original sender, only these may say an earlier item can be ignored.
   */
  trusted: string[];
  /** Apps (see DISCOVERY_APPS) where a Dot may propose actions for approval. */
  allowedApps: string[];
  /**
   * Days an item's full text is kept once its facts are remembered. Items
   * still waiting on the owner are kept however old.
   */
  retentionDays: number;
}
/**
 * A flagged item a Dot has looked into, waiting for the owner's choice:
 * - open: waiting for the owner.
 * - preparing / prepared: "Prepare it for me" is running / done.
 * - handling / handled: "Handle it" is running / done.
 * - snoozed: "Not now" until `snoozeUntil`, then open again.
 * - dismissed: "Not now" for good; counts toward the sender's triage rule.
 * - failed: preparing or handling did not finish; see `error`.
 * - closed: a later item said it no longer needs the owner.
 */
export type ProposalState =
  | 'open'
  | 'preparing'
  | 'prepared'
  | 'handling'
  | 'handled'
  | 'snoozed'
  | 'dismissed'
  | 'failed'
  | 'closed';
/** The three standard choices. "Not now" is snooze or dismiss. */
export type ProposalChoice = 'prepare' | 'handle' | 'not_now';
export type ProposalDecision = 'prepare' | 'handle' | 'snooze' | 'dismiss';
export interface ProposalView {
  id: string;
  findingId: string;
  eventId: string;
  dotId: string;
  /** The proposal's own conversation, for follow-up questions. */
  threadId: string;
  title: string;
  /** The Dot's findings, shortened. */
  summary: string;
  /** Which of the three choices fit this item. */
  options: ProposalChoice[];
  state: ProposalState;
  decision: ProposalDecision | null;
  decidedAt: number | null;
  snoozeUntil: number | null;
  /** Higher first: urgency, then how sure Jev was. */
  importance: number;
  urgency: Urgency | null;
  route: Route | null;
  /** The sender's address, for the triage rule. */
  sender: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}
/** A sender whose items are no longer flagged, because the owner kept
 * dismissing them. */
export interface TriageRuleView {
  sender: string;
  dismissed: number;
  lastDismissedAt: number;
}

/** One item waiting for the morning brief. */
export interface BriefEntry {
  findingId: string | null;
  eventId: string | null;
  title: string;
  body: string;
  threadId: string | null;
  /** Set when the item has the three choices. */
  proposalId: string | null;
  section: 'decisions' | 'drafts' | 'updates';
  createdAt: number;
}
