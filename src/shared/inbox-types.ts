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
export interface InboxSourceView {
  id: string;
  name: string;
  kind: SourceKind;
  type: 'mcp' | 'webhook';
  enabled: boolean;
  notify: InboxNotify;
  intervalSeconds: number;
  config: McpSourceConfig | Record<string, never>;
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
}
export interface InboxState {
  sources: InboxSourceView[];
  events: InboxEventView[];
}
