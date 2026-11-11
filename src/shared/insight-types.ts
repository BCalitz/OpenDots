/** Run inspector, cost meter and audit view (roadmap phase 2). */
type RunStatus = 'running' | 'finished' | 'error' | 'stopped' | 'interrupted';
export interface RunSummary {
  id: string;
  threadId: string;
  threadName: string | null;
  agentId: string;
  status: RunStatus;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  toolCalls: number;
  prompt: string | null;
}
export type RunStep =
  | {
      kind: 'prompt';
      at: number;
      source: 'chat' | 'voice' | 'schedule' | 'delegation';
      text: string;
    }
  | { kind: 'message'; at: number; text: string }
  | {
      kind: 'tool';
      at: number;
      endedAt: number | null;
      toolCallId: string;
      name: string;
      /** Owner approval or page review tools. */
      approval: boolean;
      args: string;
      result: string | null;
    }
  /** A tool result the owner supplied, such as an approval decision. */
  | { kind: 'decision'; at: number; toolCallId: string; text: string }
  | { kind: 'error'; at: number; message: string }
  | {
      kind: 'finished';
      at: number;
      usage: {
        model: string | null;
        inputTokens: number;
        outputTokens: number;
      }[];
    };
export interface RunDetail {
  run: Omit<RunSummary, 'threadName' | 'toolCalls' | 'prompt'>;
  threadName: string | null;
  steps: RunStep[];
}
export interface DotUsage {
  dotId: string;
  /** Calendar month to date, UTC. */
  inputTokens: number;
  outputTokens: number;
  runs: number;
  monthlyTokenCap: number | null;
  capReached: boolean;
}
export interface DailyUsage {
  day: string;
  dotId: string;
  inputTokens: number;
  outputTokens: number;
  runs: number;
}
export interface UsageReport {
  month: string;
  dots: DotUsage[];
  daily: DailyUsage[];
}
export interface AuditEntry {
  id: string;
  at: number;
  dotId: string | null;
  threadId: string | null;
  kind: 'mcp' | 'app' | 'computer';
  /** Connection, toolkit or computer. */
  target: string;
  action: string;
  actor: 'agent' | 'owner';
  /** Approved by the owner before it ran. */
  approved: boolean;
  outcome: 'pending' | 'succeeded' | 'failed';
}
