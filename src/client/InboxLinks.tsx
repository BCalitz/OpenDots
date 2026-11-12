import { useEffect, useMemo, useRef, useState } from 'react';
import { Link2 } from 'lucide-react';
import type {
  LinkItem,
  LinkTag,
  LinksState,
  TagKind,
} from '../shared/inbox-types';
import { api } from './api';

/** Fixed order: a kind keeps its color however many kinds are shown. */
const KINDS: { kind: TagKind; label: string }[] = [
  { kind: 'invoice', label: 'Invoice' },
  { kind: 'order', label: 'Order' },
  { kind: 'ticket', label: 'Ticket' },
  { kind: 'amount', label: 'Amount' },
  { kind: 'email', label: 'Email' },
  { kind: 'domain', label: 'Company domain' },
  { kind: 'person', label: 'Person' },
  { kind: 'project', label: 'Project' },
  { kind: 'place', label: 'Place' },
  { kind: 'name', label: 'Name' },
];
// Free-form names share one colour; the group labels tell them apart.
const NAMES: TagKind[] = ['project', 'place', 'name'];
const isName = (kind: TagKind) => NAMES.includes(kind);
const kindLabel = (kind: TagKind) =>
  KINDS.find((entry) => entry.kind === kind)?.label ?? kind;
const color = (kind: TagKind) =>
  isName(kind)
    ? 'var(--tag-8)'
    : `var(--tag-${KINDS.findIndex((entry) => entry.kind === kind) + 1})`;
/** Names read better as written; identifiers in their one spelling. */
const label = (tag: LinkTag) => (isName(tag.kind) ? tag.value : tag.normalized);
const key = (tag: { kind: TagKind; normalized: string }) =>
  `${tag.kind}:${tag.normalized}`;
const day = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  });
const when = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

const LANE = 64;
const BASE_MARGIN = { top: 16, right: 20, bottom: 30, left: 120 };

/**
 * Which inbox items share an invoice number, ticket, amount, address,
 * company or person. Items sit on a timeline, one lane per source; picking
 * a tag joins the items that carry it, and tags spelled alike join with a
 * dashed line.
 */
export function InboxLinks() {
  const [days, setDays] = useState(90);
  const [state, setState] = useState<LinksState>();
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string>();
  const [hover, setHover] = useState<{
    item: LinkItem;
    x: number;
    y: number;
  }>();
  const [showSingles, setShowSingles] = useState(false);
  const [width, setWidth] = useState(800);
  const frame = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    const load = () =>
      api<LinksState>(`/inbox/links?days=${days}`)
        .then((value) => {
          if (!live) return;
          setState(value);
          setError('');
        })
        .catch(
          (e) => live && setError(e instanceof Error ? e.message : String(e)),
        );
    void load();
    const timer = setInterval(() => void load(), 15000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [days]);
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(320, entry.contentRect.width)),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [state]);

  const shared = useMemo(
    () => (state?.tags ?? []).filter((tag) => tag.itemIds.length > 1),
    [state],
  );
  const tagByKey = useMemo(
    () => new Map((state?.tags ?? []).map((tag) => [key(tag), tag])),
    [state],
  );
  const tagsOf = useMemo(() => {
    const map = new Map<string, LinkTag[]>();
    for (const tag of state?.tags ?? [])
      for (const id of tag.itemIds) map.set(id, [...(map.get(id) ?? []), tag]);
    return map;
  }, [state]);
  // Default to the identifier that links the most items: an invoice or
  // ticket says more than the owner's own domain.
  const rank = (tag: LinkTag) =>
    KINDS.findIndex((entry) => entry.kind === tag.kind);
  const active =
    (selected && tagByKey.get(selected)) ||
    [...shared].sort(
      (a, b) => rank(a) - rank(b) || b.itemIds.length - a.itemIds.length,
    )[0];
  const alike = useMemo(
    () =>
      active
        ? (state?.similar ?? [])
            .filter(
              (pair) =>
                pair.kind === active.kind &&
                (pair.a === active.normalized || pair.b === active.normalized),
            )
            .map((pair) => ({
              similarity: pair.similarity,
              tag: tagByKey.get(
                `${pair.kind}:${pair.a === active.normalized ? pair.b : pair.a}`,
              ),
            }))
            .filter((entry): entry is { similarity: number; tag: LinkTag } =>
              Boolean(entry.tag),
            )
        : [],
    [active, state, tagByKey],
  );

  if (error) return <p className="chat-error">{error}</p>;
  if (!state) return <p className="muted">Loading links…</p>;
  if (!state.items.length)
    return (
      <div className="large-empty">
        <Link2 size={32} />
        <h2>No tagged items yet.</h2>
        <p>
          Invoice numbers, tickets, amounts, addresses, people, projects, places
          and other names are picked out of new items as they arrive. Try{' '}
          <code>npm run seed-demo</code> for made-up examples.
        </p>
      </div>
    );

  const lanes = [...new Set(state.items.map((item) => item.sourceName))].sort();
  // Narrow screens give the plot more room and fewer date labels.
  const narrow = width < 520;
  const MARGIN = { ...BASE_MARGIN, left: narrow ? 92 : BASE_MARGIN.left };
  const height = MARGIN.top + lanes.length * LANE + MARGIN.bottom;
  const times = state.items.map((item) => item.occurredAt);
  const end = Math.max(Date.now(), ...times);
  const start = Math.min(...times) - 12 * 3_600_000;
  const plot = width - MARGIN.left - MARGIN.right;
  const x = (ms: number) => MARGIN.left + ((ms - start) / (end - start)) * plot;
  // Items in one lane spread over three rows so neighbours stay apart.
  const position = new Map<string, { x: number; y: number }>();
  for (const lane of lanes)
    state.items
      .filter((item) => item.sourceName === lane)
      .sort((a, b) => a.occurredAt - b.occurredAt)
      .forEach((item, index) =>
        position.set(item.id, {
          x: x(item.occurredAt),
          y:
            MARGIN.top +
            lanes.indexOf(lane) * LANE +
            LANE / 2 +
            ((index % 3) - 1) * 14,
        }),
      );
  const tickCount = narrow ? 4 : 6;
  const ticks = Array.from(
    { length: tickCount },
    (_, i) => start + ((end - start) * i) / (tickCount - 1),
  );
  const path = (tag: LinkTag) =>
    tag.itemIds
      .map((id) => ({ id, at: state.items.find((item) => item.id === id) }))
      .filter((entry) => entry.at)
      .sort((a, b) => a.at!.occurredAt - b.at!.occurredAt)
      .map((entry, index) => {
        const point = position.get(entry.id)!;
        return `${index ? 'L' : 'M'}${point.x},${point.y}`;
      })
      .join(' ');
  const inActive = new Set(active?.itemIds);
  const inAlike = new Set(alike.flatMap((entry) => entry.tag.itemIds));
  const ordered = active
    ? state.items
        .filter((item) => inActive.has(item.id) || inAlike.has(item.id))
        .sort((a, b) => a.occurredAt - b.occurredAt)
    : [];
  const kindsShown = KINDS.filter((entry) =>
    (showSingles ? state.tags : shared).some((tag) => tag.kind === entry.kind),
  );

  return (
    <section className="links-viz">
      <div className="insight-toolbar">
        <select
          className="insight-filter"
          aria-label="Time range"
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
        >
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
          <option value={365}>Last year</option>
          <option value={3650}>Everything</option>
        </select>
        <label className="permission-row inline">
          <input
            type="checkbox"
            checked={showSingles}
            onChange={(e) => setShowSingles(e.target.checked)}
          />
          <span>Show tags on one item only</span>
        </label>
        <span className="muted links-count">
          {state.items.length} items · {shared.length} shared tags
        </span>
      </div>

      <div className="links-chart" ref={frame}>
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={
            active
              ? `Timeline of ${state.items.length} items by source; ${active.itemIds.length} carry ${kindLabel(active.kind)} ${label(active)}.`
              : `Timeline of ${state.items.length} items by source.`
          }
          onMouseLeave={() => setHover(undefined)}
        >
          {lanes.map((lane, index) => (
            <g key={lane}>
              {index > 0 && (
                <line
                  className="links-rule"
                  x1={MARGIN.left}
                  x2={width - MARGIN.right}
                  y1={MARGIN.top + index * LANE}
                  y2={MARGIN.top + index * LANE}
                />
              )}
              <text
                className="links-lane"
                x={MARGIN.left - 12}
                y={MARGIN.top + index * LANE + LANE / 2}
                textAnchor="end"
                dominantBaseline="middle"
              >
                {lane}
              </text>
            </g>
          ))}
          <line
            className="links-axis"
            x1={MARGIN.left}
            x2={width - MARGIN.right}
            y1={height - MARGIN.bottom}
            y2={height - MARGIN.bottom}
          />
          {ticks.map((tick, index) => (
            <text
              key={tick}
              className="links-tick"
              x={x(tick)}
              y={height - MARGIN.bottom + 18}
              // The end labels stay inside the plot.
              textAnchor={
                index === 0
                  ? 'start'
                  : index === ticks.length - 1
                    ? 'end'
                    : 'middle'
              }
            >
              {day(tick)}
            </text>
          ))}
          {alike.map((entry) => (
            <path
              key={key(entry.tag)}
              d={path(entry.tag)}
              className="links-line alike"
              style={{ stroke: color(entry.tag.kind) }}
            />
          ))}
          {active && (
            <path
              d={path(active)}
              className="links-line"
              style={{ stroke: color(active.kind) }}
            />
          )}
          {state.items.map((item) => {
            const point = position.get(item.id)!;
            const on = inActive.has(item.id);
            const near = !on && inAlike.has(item.id);
            return (
              <g
                key={item.id}
                className={`links-item ${active && !on && !near ? 'faded' : ''}`}
                onMouseEnter={() => setHover({ item, ...point })}
                onClick={() => setHover({ item, ...point })}
              >
                <circle
                  cx={point.x}
                  cy={point.y}
                  r={12}
                  className="links-hit"
                />
                <circle
                  cx={point.x}
                  cy={point.y}
                  r={on ? 6 : 5}
                  className={`links-dot ${on ? 'on' : near ? 'near' : ''}`}
                  style={
                    active && (on || near)
                      ? on
                        ? { fill: color(active.kind) }
                        : { stroke: color(active.kind) }
                      : undefined
                  }
                />
              </g>
            );
          })}
        </svg>
        {hover && (
          <div
            className="links-tooltip"
            style={{
              left: Math.max(8, Math.min(hover.x + 14, width - 280)),
              // Open upward in the lower half so the card stays in view.
              ...(hover.y > height / 2
                ? { bottom: height - hover.y + 28 }
                : { top: hover.y + 20 }),
            }}
            role="status"
          >
            <strong>{hover.item.title ?? '(no longer in the inbox)'}</strong>
            <span>
              {hover.item.sourceName} · {when(hover.item.occurredAt)}
            </span>
            {hover.item.from && <span>From {hover.item.from}</span>}
            <span className="links-tooltip-tags">
              {(tagsOf.get(hover.item.id) ?? []).map((tag) => (
                <button
                  key={key(tag)}
                  className="links-chip small"
                  onClick={() => setSelected(key(tag))}
                >
                  <i style={{ background: color(tag.kind) }} aria-hidden />
                  {tag.value}
                </button>
              ))}
            </span>
          </div>
        )}
      </div>

      <div className="links-legend" aria-label="Tag kinds">
        {kindsShown
          .filter((entry) => !isName(entry.kind))
          .map((entry) => (
            <span key={entry.kind}>
              <i style={{ background: color(entry.kind) }} aria-hidden />
              {entry.label}
            </span>
          ))}
        {kindsShown.some((entry) => isName(entry.kind)) && (
          <span>
            <i style={{ background: color('name') }} aria-hidden />
            Project, place or name
          </span>
        )}
      </div>

      <div className="links-panels">
        <div>
          <h2 className="insight-subhead">Tags</h2>
          {kindsShown.map((entry) => (
            <div key={entry.kind} className="links-group">
              <span className="links-group-name">{entry.label}</span>
              <div className="links-chips">
                {(showSingles ? state.tags : shared)
                  .filter((tag) => tag.kind === entry.kind)
                  .map((tag) => (
                    <button
                      key={key(tag)}
                      className={`links-chip ${active && key(active) === key(tag) ? 'active' : ''}`}
                      aria-pressed={!!active && key(active) === key(tag)}
                      onClick={() => setSelected(key(tag))}
                    >
                      <i style={{ background: color(tag.kind) }} aria-hidden />
                      {label(tag)}
                      <span>{tag.itemIds.length}</span>
                    </button>
                  ))}
              </div>
            </div>
          ))}
          {!kindsShown.length && (
            <p className="muted">No tag is shared by two items yet.</p>
          )}
        </div>
        <div>
          <h2 className="insight-subhead">
            {active
              ? `${kindLabel(active.kind)} ${label(active)}`
              : 'Pick a tag'}
          </h2>
          {alike.length > 0 && (
            <p className="links-alike">
              Spelled alike:{' '}
              {alike.map((entry) => (
                <button
                  key={key(entry.tag)}
                  className="links-chip small"
                  onClick={() => setSelected(key(entry.tag))}
                >
                  {label(entry.tag)}
                  <span>{Math.round(entry.similarity * 100)}%</span>
                </button>
              ))}
              <span className="muted"> (dashed; possibly the same thing)</span>
            </p>
          )}
          <ol className="links-list">
            {ordered.map((item) => (
              <li
                key={item.id}
                className={inActive.has(item.id) ? '' : 'alike'}
              >
                <span className="muted">
                  {when(item.occurredAt)} · {item.sourceName}
                </span>
                <strong>{item.title ?? '(no longer in the inbox)'}</strong>
                {item.from && <span className="muted">From {item.from}</span>}
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
