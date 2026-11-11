export type Status =
  | 'queued'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'cancelled';
export interface Settings {
  name: string;
  paused: boolean;
  researchAllowed: boolean;
  memoryAllowed: boolean;
  appsAllowed: boolean;
}
export interface Task {
  id: string;
  prompt: string;
  status: Status;
  intervalSeconds: number | null;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
  error: string | null;
  lease: string | null;
  leaseUntil: number | null;
}
export interface Source {
  title: string;
  url: string;
  excerpt: string;
}
export interface Result {
  text: string;
  sources: Source[];
  sample: boolean;
  screenshot?: string;
}
export interface Run {
  id: string;
  taskId: string;
  status: string;
  startedAt: number;
  finishedAt: number | null;
  result: Result | null;
  error: string | null;
}
export interface TaskEvent {
  id: number;
  taskId: string;
  runId: string | null;
  text: string;
  createdAt: number;
}
export interface Memory {
  id: string;
  text: string;
  createdAt: number;
}
export interface Detail {
  task: Task;
  runs: Run[];
  events: TaskEvent[];
}
export interface State {
  settings: Settings;
  tasks: Task[];
  memories: Memory[];
  mode: 'sample' | 'live';
  configured: boolean;
}
export type Action = 'run' | 'pause' | 'cancel';
export interface Space {
  id: string;
  name: string;
  description: string;
  createdAt: number;
}
export interface Dot {
  id: string;
  /** Default destination for saved pages, not ownership. */
  spaceId: string;
  spaceIds: string[];
  name: string;
  instructions: string;
  researchAllowed: boolean;
  memoryAllowed: boolean;
  appsAllowed: boolean;
  composioToolkits: string[];
  composioSessionId?: string | null;
  composioPolicyHash?: string | null;
  createdAt: number;
  /** Tokens per UTC month; at the cap the Dot stops starting new turns. */
  monthlyTokenCap?: number | null;
  /** Other Dots this one may hand work to with ask_dot. */
  delegateDotIds?: string[];
}
export interface Conversation {
  id: string;
  dotId: string;
  ownerId: string;
  title: string;
  createdAt: number;
  /** Set for background threads, such as one mirroring a Slack thread. */
  source?: string;
}
export interface CallReceipt {
  anchorMessageId?: string | null;
  id: string;
  threadId: string;
  startedAt: number;
  endedAt: number | null;
  status: 'connecting' | 'active' | 'ended' | 'failed';
  transcript: string;
  error: string | null;
}
export interface SetupStatus {
  /** Where conversations are stored. */
  model: boolean;
  browser: boolean;
  voice: boolean;
  composio: boolean;
  slack: string;
  missing: string[];
}
/** An app account connected through Composio, without its credentials. */
export interface ConnectedAccount {
  id: string;
  /** Composio toolkit slug, for example gmail or quickbooks. */
  toolkit: string;
  name: string;
  status: string;
  statusReason: string | null;
  alias: string | null;
  disabled: boolean;
  createdAt: string;
}
export interface WorkspaceState {
  spaces: Space[];
  dots: Dot[];
  conversations: Conversation[];
  /** Each Dot's one continuing chat, by Dot id. */
  mainConversations: Record<string, string>;
  setup: SetupStatus;
  calls: CallReceipt[];
}
