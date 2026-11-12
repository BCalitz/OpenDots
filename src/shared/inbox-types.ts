/** Event engine (roadmap phase 3): outside activity as normalized events. */
export type SourceKind = 'ticket' | 'mail' | 'message' | 'calendar';
export type InboxPriority = 'low' | 'normal' | 'high' | 'urgent';
export type InboxEventState = 'new' | 'seen' | 'dismissed';
/** When a new event sends a push notification. */
export type InboxNotify = 'off' | 'urgent' | 'high' | 'all';
export interface McpSourceConfig {
  dotId: string;
  connectionId: string;
  /** The real MCP tool name on that connection. */
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
 * Discovery on an app account connected through Composio: new items are
 * read on a timer, a small model flags the ones that need attention, and
 * `dotId` investigates them read-only.
 */
export interface ComposioSourceConfig {
  dotId: string;
  /** Composio connected account id. */
  accountId: string;
  /** Composio toolkit slug, one of DISCOVERY_TOOLKITS. */
  toolkit: string;
}
export type SourceType = 'mcp' | 'webhook' | 'composio';
export type SourceConfig =
  McpSourceConfig | ComposioSourceConfig | Record<string, never>;
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
 */
export type FindingState =
  'ignored' | 'flagged' | 'investigating' | 'ready' | 'failed';
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
  createdAt: number;
  updatedAt: number;
}
export interface InboxState {
  sources: InboxSourceView[];
  events: InboxEventView[];
}

/** What a tag identifies. */
export type TagKind =
  'invoice' | 'order' | 'ticket' | 'amount' | 'email' | 'domain' | 'person';
/** An item on the links view. Pruned items keep their tags, not their text. */
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
/** One normalized tag and every item that carries it. */
export interface LinkTag {
  kind: TagKind;
  normalized: string;
  /** How it was written the first time. */
  value: string;
  itemIds: string[];
}
/** Two tags of one kind that are spelled alike (pg_trgm similarity). */
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
export const DISCOVERY_TOOLKITS: Record<
  string,
  { name: string; kind: SourceKind }
> = {
  gmail: { name: 'Gmail', kind: 'mail' },
  outlook: { name: 'Outlook', kind: 'mail' },
  microsoft_teams: { name: 'Microsoft Teams', kind: 'message' },
};
/** Discovery settings for one connected account. */
export interface DiscoveryAccountView {
  sourceId: string;
  accountId: string;
  toolkit: string;
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
}
