import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  ArrowLeft,
  CircleAlert,
  Gauge,
  MessageCircle,
  Monitor,
  Plug,
  ShieldCheck,
  Wrench,
} from 'lucide-react';
import type { Dot } from '../shared/types';
import type {
  AuditEntry,
  RunDetail,
  RunStep,
  RunSummary,
  UsageReport,
} from '../shared/insight-types';
import { api } from './api';
import { relative } from './TaskPresentation';

type Tab = 'runs' | 'usage' | 'audit';
const tokens = (value: number | null | undefined) =>
  value == null
    ? '–'
    : value >= 1_000_000
      ? `${(value / 1_000_000).toFixed(1)}M`
      : value >= 1000
        ? `${(value / 1000).toFixed(1)}k`
        : String(value);
const duration = (from: number, to: number | null) => {
  if (!to) return 'running';
  const ms = to - from;
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
};
const statusClass: Record<RunSummary['status'], string> = {
  running: 'running',
  finished: 'completed',
  error: 'failed',
  stopped: 'paused',
  interrupted: 'interrupted',
};
const statusName: Record<RunSummary['status'], string> = {
  running: 'Running',
  finished: 'Finished',
  error: 'Error',
  stopped: 'Stopped',
  interrupted: 'Interrupted',
};
const sourceName = {
  chat: 'Chat',
  voice: 'Call',
  schedule: 'Schedule',
  delegation: 'Dot request',
};

/** Run inspector, cost meter and audit trail. */
export function InsightsView({
  dots,
  onThread,
}: {
  dots: Dot[];
  onThread: (threadId: string) => void;
}) {
  const [tab, setTab] = useState<Tab>('runs');
  const dotName = (id: string | null) =>
    dots.find((dot) => dot.id === id)?.name ?? 'Removed Dot';
  return (
    <main className="main-content insights">
      <div className="page-heading">
        <div>
          <span className="eyebrow">SEE WHAT IT IS DOING</span>
          <h1>Insights</h1>
          <p>
            Every run, what it cost, and everything your Dots did outside
            OpenDots.
          </p>
        </div>
      </div>
      <div className="insight-tabs" role="tablist" aria-label="Insights">
        {(
          [
            ['runs', 'Runs', Activity],
            ['usage', 'Usage', Gauge],
            ['audit', 'Audit', ShieldCheck],
          ] as const
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? 'active' : ''}
            onClick={() => setTab(id)}
          >
            <Icon size={15} />
            {label}
          </button>
        ))}
      </div>
      {tab === 'runs' && (
        <Runs dots={dots} dotName={dotName} onThread={onThread} />
      )}
      {tab === 'usage' && <Usage dots={dots} dotName={dotName} />}
      {tab === 'audit' && <Audit dots={dots} dotName={dotName} />}
    </main>
  );
}

function usePolled<T>(path: string, ms = 5000) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState('');
  const load = useCallback(
    () =>
      api<T>(path)
        .then((value) => {
          setData(value);
          setError('');
        })
        .catch((e) => setError(e instanceof Error ? e.message : String(e))),
    [path],
  );
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), ms);
    return () => clearInterval(timer);
  }, [load, ms]);
  return { data, error };
}

function DotFilter({
  dots,
  value,
  onChange,
}: {
  dots: Dot[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <select
      className="insight-filter"
      aria-label="Filter by Dot"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">All Dots</option>
      {dots.map((dot) => (
        <option key={dot.id} value={dot.id}>
          {dot.name}
        </option>
      ))}
    </select>
  );
}

function Runs({
  dots,
  dotName,
  onThread,
}: {
  dots: Dot[];
  dotName: (id: string | null) => string;
  onThread: (threadId: string) => void;
}) {
  const [dotId, setDotId] = useState('');
  const [open, setOpen] = useState<string>();
  const { data, error } = usePolled<RunSummary[]>(
    `/runs${dotId ? `?dotId=${encodeURIComponent(dotId)}` : ''}`,
  );
  if (open)
    return (
      <Inspector
        runId={open}
        dotName={dotName}
        onBack={() => setOpen(undefined)}
        onThread={onThread}
      />
    );
  return (
    <>
      <div className="insight-toolbar">
        <DotFilter dots={dots} value={dotId} onChange={setDotId} />
      </div>
      {error && <p className="chat-error">{error}</p>}
      <div className="task-list">
        {data?.map((run) => (
          <button
            className="task-row"
            key={run.id}
            onClick={() => setOpen(run.id)}
          >
            <span className="task-row-icon">
              {run.status === 'error' ? (
                <CircleAlert size={18} />
              ) : (
                <MessageCircle size={18} />
              )}
            </span>
            <div>
              <strong>{run.prompt ?? run.threadName ?? 'Continued run'}</strong>
              <span>
                {dotName(run.agentId)} · {run.threadName ?? 'Untitled thread'} ·{' '}
                {relative(run.startedAt)} ·{' '}
                {duration(run.startedAt, run.finishedAt)} ·{' '}
                {tokens(
                  run.inputTokens == null
                    ? null
                    : run.inputTokens + (run.outputTokens ?? 0),
                )}{' '}
                tokens
                {run.toolCalls ? ` · ${run.toolCalls} tool calls` : ''}
              </span>
            </div>
            <span className={`status ${statusClass[run.status]}`}>
              <span />
              {statusName[run.status]}
            </span>
          </button>
        ))}
      </div>
      {data && !data.length && (
        <div className="large-empty">
          <Activity size={32} />
          <h2>No runs yet.</h2>
          <p>
            Each answer a Dot gives, in chat, calls or schedules, shows up here.
          </p>
        </div>
      )}
    </>
  );
}

function Step({ step, start }: { step: RunStep; start: number }) {
  const offset =
    step.at && start ? `+${((step.at - start) / 1000).toFixed(1)}s` : '';
  if (step.kind === 'prompt')
    return (
      <li className="run-step prompt">
        <header>
          <MessageCircle size={14} />
          <strong>{sourceName[step.source]} prompt</strong>
          <time>{offset}</time>
        </header>
        <pre>{step.text}</pre>
      </li>
    );
  if (step.kind === 'message')
    return (
      <li className="run-step">
        <header>
          <MessageCircle size={14} />
          <strong>Answer</strong>
          <time>{offset}</time>
        </header>
        <pre>{step.text}</pre>
      </li>
    );
  if (step.kind === 'tool')
    return (
      <li className={`run-step tool ${step.approval ? 'approval' : ''}`}>
        <header>
          {step.approval ? <ShieldCheck size={14} /> : <Wrench size={14} />}
          <strong>{step.name}</strong>
          {step.approval && <small>Owner approval</small>}
          <time>
            {offset}
            {step.endedAt ? ` · ${duration(step.at, step.endedAt)}` : ''}
          </time>
        </header>
        {step.args && (
          <details>
            <summary>Arguments</summary>
            <pre>{step.args}</pre>
          </details>
        )}
        <details open={!!step.result && step.result.length < 400}>
          <summary>Result</summary>
          <pre>
            {step.result ??
              (step.approval
                ? 'Waiting for the owner. The decision arrives in the next run.'
                : 'No result recorded.')}
          </pre>
        </details>
      </li>
    );
  if (step.kind === 'decision')
    return (
      <li className="run-step approval">
        <header>
          <ShieldCheck size={14} />
          <strong>Owner decision</strong>
          <time>{offset}</time>
        </header>
        <pre>{step.text}</pre>
      </li>
    );
  if (step.kind === 'error')
    return (
      <li className="run-step error">
        <header>
          <CircleAlert size={14} />
          <strong>Error</strong>
          <time>{offset}</time>
        </header>
        <pre>{step.message}</pre>
      </li>
    );
  return (
    <li className="run-step">
      <header>
        <Gauge size={14} />
        <strong>Finished</strong>
        <time>{offset}</time>
      </header>
      <p className="muted">
        {step.usage.length
          ? step.usage
              .map(
                (entry) =>
                  `${entry.model ?? 'model'}: ${tokens(entry.inputTokens)} in, ${tokens(entry.outputTokens)} out`,
              )
              .join(' · ')
          : 'The model did not report token usage.'}
      </p>
    </li>
  );
}

function Inspector({
  runId,
  dotName,
  onBack,
  onThread,
}: {
  runId: string;
  dotName: (id: string | null) => string;
  onBack: () => void;
  onThread: (threadId: string) => void;
}) {
  const { data, error } = usePolled<RunDetail>(`/runs/${runId}`, 3000);
  return (
    <section className="run-inspector">
      <div className="insight-toolbar">
        <button className="text-button" onClick={onBack}>
          <ArrowLeft size={14} /> All runs
        </button>
        {data && (
          <button
            className="text-button"
            onClick={() => onThread(data.run.threadId)}
          >
            Open conversation
          </button>
        )}
      </div>
      {error && <p className="chat-error">{error}</p>}
      {data && (
        <>
          <dl className="run-facts">
            <div>
              <dt>Dot</dt>
              <dd>{dotName(data.run.agentId)}</dd>
            </div>
            <div>
              <dt>Thread</dt>
              <dd>{data.threadName ?? 'Untitled'}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>
                <span className={`status ${statusClass[data.run.status]}`}>
                  <span />
                  {statusName[data.run.status]}
                </span>
              </dd>
            </div>
            <div>
              <dt>Started</dt>
              <dd>{new Date(data.run.startedAt).toLocaleString()}</dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>{duration(data.run.startedAt, data.run.finishedAt)}</dd>
            </div>
            <div>
              <dt>Tokens</dt>
              <dd>
                {tokens(data.run.inputTokens)} in ·{' '}
                {tokens(data.run.outputTokens)} out
              </dd>
            </div>
          </dl>
          {data.run.error && <p className="chat-error">{data.run.error}</p>}
          <ol className="run-steps">
            {data.steps.map((step, index) => (
              <Step key={index} step={step} start={data.run.startedAt} />
            ))}
          </ol>
          {!data.steps.length && (
            <p className="muted">This run stored no events.</p>
          )}
        </>
      )}
    </section>
  );
}

function Usage({
  dots,
  dotName,
}: {
  dots: Dot[];
  dotName: (id: string | null) => string;
}) {
  const { data, error } = usePolled<UsageReport>('/usage?days=14', 10_000);
  if (error) return <p className="chat-error">{error}</p>;
  if (!data) return null;
  const days = [...new Set(data.daily.map((row) => row.day))];
  const dayTotal = (day: string) =>
    data.daily
      .filter((row) => row.day === day)
      .reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0);
  const peak = Math.max(1, ...days.map(dayTotal));
  return (
    <>
      <h2 className="insight-subhead">This month ({data.month}, UTC)</h2>
      <div className="usage-grid">
        {data.dots.map((usage) => {
          const used = usage.inputTokens + usage.outputTokens;
          const cap = usage.monthlyTokenCap;
          return (
            <article
              className={`usage-card ${usage.capReached ? 'capped' : ''}`}
              key={usage.dotId}
            >
              <strong>{dotName(usage.dotId)}</strong>
              <span className="usage-total">{tokens(used)}</span>
              <small>
                {tokens(usage.inputTokens)} in · {tokens(usage.outputTokens)}{' '}
                out · {usage.runs} runs
              </small>
              {cap ? (
                <>
                  <meter
                    min={0}
                    max={cap}
                    low={cap * 0.75}
                    high={cap * 0.9}
                    optimum={0}
                    value={Math.min(used, cap)}
                    aria-label={`${dotName(usage.dotId)} usage against its limit`}
                  />
                  <small>
                    {usage.capReached
                      ? `Limit reached (${tokens(cap)}). New turns are paused.`
                      : `${Math.round((used / cap) * 100)}% of ${tokens(cap)} limit`}
                  </small>
                </>
              ) : (
                <small className="muted">
                  No monthly limit. Set one in this Dot’s settings.
                </small>
              )}
            </article>
          );
        })}
      </div>
      <h2 className="insight-subhead">Last 14 days</h2>
      {days.length ? (
        <table className="usage-days">
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">Tokens</th>
              <th scope="col">By Dot</th>
            </tr>
          </thead>
          <tbody>
            {days.map((day) => (
              <tr key={day}>
                <th scope="row">{day}</th>
                <td>
                  <span
                    className="usage-bar"
                    style={{ width: `${(dayTotal(day) / peak) * 100}%` }}
                  />
                  {tokens(dayTotal(day))}
                </td>
                <td className="muted">
                  {data.daily
                    .filter((row) => row.day === day)
                    .map(
                      (row) =>
                        `${dotName(row.dotId)} ${tokens(row.inputTokens + row.outputTokens)}`,
                    )
                    .join(' · ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">
          No token usage recorded yet.{' '}
          {dots.length > 1 ? 'Your Dots' : 'Your Dot'} will show here after the
          first answer.
        </p>
      )}
    </>
  );
}

const kindIcon = { mcp: Plug, app: Plug, computer: Monitor };
const kindName = { mcp: 'Connection', app: 'App', computer: 'Computer' };
function Audit({
  dots,
  dotName,
}: {
  dots: Dot[];
  dotName: (id: string | null) => string;
}) {
  const [dotId, setDotId] = useState('');
  const [changes, setChanges] = useState(true);
  const query = new URLSearchParams({
    ...(dotId ? { dotId } : {}),
    changes: changes ? '1' : '0',
  });
  const { data, error } = usePolled<AuditEntry[]>(`/audit?${query}`);
  return (
    <>
      <div className="insight-toolbar">
        <DotFilter dots={dots} value={dotId} onChange={setDotId} />
        <label className="permission-row inline">
          <input
            type="checkbox"
            checked={changes}
            onChange={(e) => setChanges(e.target.checked)}
          />
          <span>Hide read-only connection calls</span>
        </label>
      </div>
      {error && <p className="chat-error">{error}</p>}
      <ul className="audit-list">
        {data?.map((entry) => {
          const Icon = kindIcon[entry.kind];
          return (
            <li key={entry.id}>
              <Icon size={16} aria-hidden />
              <div>
                <strong>
                  {entry.target} · {entry.action}
                </strong>
                <span>
                  {kindName[entry.kind]} · {dotName(entry.dotId)} ·{' '}
                  {entry.actor === 'owner' ? 'by you' : 'by the Dot'}
                  {entry.approved ? ' · approved by you' : ''} ·{' '}
                  {relative(entry.at)}
                </span>
              </div>
              <span
                className={`status ${entry.outcome === 'succeeded' ? 'completed' : entry.outcome === 'failed' ? 'failed' : 'running'}`}
              >
                <span />
                {entry.outcome === 'succeeded'
                  ? 'Done'
                  : entry.outcome === 'failed'
                    ? 'Failed'
                    : 'Pending'}
              </span>
            </li>
          );
        })}
      </ul>
      {data && !data.length && (
        <div className="large-empty">
          <ShieldCheck size={32} />
          <h2>Nothing has left OpenDots.</h2>
          <p>
            Connection actions, app tools and computer actions are listed here
            as they happen.
          </p>
        </div>
      )}
    </>
  );
}
