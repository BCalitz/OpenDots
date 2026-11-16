import { useCallback, useEffect, useState } from 'react';
import {
  CircleAlert,
  Clock3,
  Eye,
  LoaderCircle,
  Pause,
  Square,
} from 'lucide-react';
import type { Action, Dot, Task } from '../shared/types';
import type { RunSummary } from '../shared/insight-types';
import { api } from './api';
import { relative } from './TaskPresentation';

const RECENT = 15;
const clip = (text: string, length = 110) =>
  text.length > length ? `${text.slice(0, length - 1)}…` : text;
/** What a run is about, in the owner's words: the thread or what they asked. */
const aboutRun = (run: RunSummary) =>
  clip(run.threadName ?? run.prompt ?? 'Working on a request');

/** Only the newest run of a thread still counts as blocked: later work moves on. */
export function blockedRuns(runs: RunSummary[]) {
  const newest = new Map<string, RunSummary>();
  for (const run of runs)
    if (
      !newest.has(run.threadId) ||
      run.startedAt > newest.get(run.threadId)!.startedAt
    )
      newest.set(run.threadId, run);
  return [...newest.values()].filter((run) => run.status === 'blocked');
}

/**
 * What the Dots are doing: stuck work first, then what is running now, what
 * is scheduled, and what finished lately. Insights stays the technical view.
 */
export function ActivityView({
  dots,
  tasks,
  onThread,
  onTaskAction,
}: {
  dots: Dot[];
  tasks: Task[];
  onThread: (threadId: string) => void;
  onTaskAction: (taskId: string, action: Action) => unknown;
}) {
  const [dotId, setDotId] = useState('');
  const [runs, setRuns] = useState<RunSummary[]>();
  const [error, setError] = useState('');
  const dotName = (id: string) =>
    dots.find((dot) => dot.id === id)?.name ?? 'Removed Dot';
  const load = useCallback(
    () =>
      api<RunSummary[]>(
        `/runs?limit=100${dotId ? `&dotId=${encodeURIComponent(dotId)}` : ''}`,
      )
        .then((list) => {
          setRuns(list);
          setError('');
        })
        .catch((e) => setError(e instanceof Error ? e.message : String(e))),
    [dotId],
  );
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);
  const stop = async (threadId: string) => {
    await api(`/chat/${encodeURIComponent(threadId)}/stop`, 'POST', {}).catch(
      () => undefined,
    );
    await load();
  };

  const blocked = blockedRuns(runs ?? []);
  const running = (runs ?? []).filter((run) => run.status === 'running');
  const done = (runs ?? [])
    .filter((run) => run.status !== 'running' && run.status !== 'blocked')
    .slice(0, RECENT);
  const scheduled = tasks
    .filter((task) => task.intervalSeconds && task.status !== 'cancelled')
    .sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity));
  return (
    <main className="main-content activity">
      <div className="page-heading">
        <div>
          <span className="eyebrow">WHAT YOUR DOTS ARE DOING</span>
          <h1>Activity</h1>
          <p>
            Work in progress, what is scheduled, and what finished. Anything
            that got stuck is at the top.
          </p>
        </div>
        <select
          className="insight-filter"
          aria-label="Filter by Dot"
          value={dotId}
          onChange={(event) => setDotId(event.target.value)}
        >
          <option value="">All Dots</option>
          {dots.map((dot) => (
            <option key={dot.id} value={dot.id}>
              {dot.name}
            </option>
          ))}
        </select>
      </div>
      {error && <p className="chat-error">{error}</p>}

      {blocked.length > 0 && (
        <section aria-label="Blocked">
          <h2 className="insight-subhead">Stuck, needs you</h2>
          <ul className="activity-list">
            {blocked.map((run) => (
              <li key={run.id} className="activity-blocked">
                <CircleAlert size={16} aria-hidden />
                <span>
                  <strong>{aboutRun(run)}</strong>
                  <small>
                    {dotName(run.agentId)} · {run.error ?? 'It got stuck.'} ·{' '}
                    {relative(run.finishedAt ?? run.startedAt)}
                  </small>
                </span>
                <button
                  className="text-button"
                  onClick={() => onThread(run.threadId)}
                >
                  <Eye size={14} /> Open
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <h2 className="insight-subhead">In progress</h2>
      <ul className="activity-list">
        {running.map((run) => (
          <li key={run.id}>
            <LoaderCircle size={16} className="spin" aria-hidden />
            <span>
              <strong>{aboutRun(run)}</strong>
              <small>
                {dotName(run.agentId)} · started {relative(run.startedAt)}
                {run.toolCalls ? ` · ${run.toolCalls} steps so far` : ''}
              </small>
            </span>
            <button
              className="text-button"
              onClick={() => onThread(run.threadId)}
            >
              <Eye size={14} /> Watch
            </button>
            <button
              className="text-button"
              aria-label={`Stop ${aboutRun(run)}`}
              onClick={() => void stop(run.threadId)}
            >
              <Square size={13} /> Stop
            </button>
          </li>
        ))}
        {runs && !running.length && <li className="muted">Nothing running.</li>}
      </ul>

      <h2 className="insight-subhead">Scheduled</h2>
      <ul className="activity-list">
        {scheduled.map((task) => (
          <li key={task.id}>
            <Clock3 size={16} aria-hidden />
            <span>
              <strong>{clip(task.prompt)}</strong>
              <small>
                {task.status === 'paused'
                  ? 'Paused'
                  : task.nextRunAt
                    ? `Next ${new Date(task.nextRunAt).toLocaleString()}`
                    : 'Waiting'}
                {' · every '}
                {Math.round((task.intervalSeconds ?? 0) / 60)} min
              </small>
            </span>
            {task.status !== 'paused' && (
              <button
                className="text-button"
                aria-label={`Pause ${clip(task.prompt, 40)}`}
                onClick={() => void onTaskAction(task.id, 'pause')}
              >
                <Pause size={14} /> Pause
              </button>
            )}
            {task.status === 'paused' && (
              <button
                className="text-button"
                onClick={() => void onTaskAction(task.id, 'run')}
              >
                Resume
              </button>
            )}
          </li>
        ))}
        {!scheduled.length && <li className="muted">Nothing scheduled.</li>}
      </ul>

      <h2 className="insight-subhead">Done</h2>
      <ul className="activity-list">
        {done.map((run) => (
          <li key={run.id}>
            <span className="activity-dot" aria-hidden />
            <span>
              <strong>{aboutRun(run)}</strong>
              <small>
                {dotName(run.agentId)} ·{' '}
                {run.status === 'error'
                  ? 'Failed'
                  : run.status === 'finished'
                    ? 'Finished'
                    : run.status === 'stopped'
                      ? 'Stopped'
                      : 'Interrupted'}{' '}
                · {relative(run.finishedAt ?? run.startedAt)}
              </small>
            </span>
            <button
              className="text-button"
              onClick={() => onThread(run.threadId)}
            >
              <Eye size={14} /> Open
            </button>
          </li>
        ))}
        {runs && !done.length && (
          <li className="muted">Nothing finished yet.</li>
        )}
      </ul>
    </main>
  );
}
