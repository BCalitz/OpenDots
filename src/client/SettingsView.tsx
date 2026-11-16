import {
  Activity,
  BookOpen,
  Clock3,
  Gauge,
  MessageCircle,
  MoreHorizontal,
  Plug,
  Plus,
  Settings2,
} from 'lucide-react';
import type { Dot, State, WorkspaceState } from '../shared/types';
import type { Dialog } from './WorkspaceDialog';
import { Mascot } from './Mascot';
import { SpaceNav } from './SpaceNav';

export type SettingsPlace =
  'accounts' | 'tasks' | 'activity' | 'insights' | 'memories';

const places: {
  place: SettingsPlace;
  label: string;
  detail: string;
  icon: typeof Plug;
}[] = [
  {
    place: 'accounts',
    label: 'Accounts',
    detail: 'Connected mail and messages, and discovery settings.',
    icon: Plug,
  },
  {
    place: 'tasks',
    label: 'Scheduled tasks',
    detail: 'Turns that run on a timer.',
    icon: Clock3,
  },
  {
    place: 'activity',
    label: 'Activity',
    detail: 'Every run, and what it did.',
    icon: Activity,
  },
  {
    place: 'insights',
    label: 'Insights',
    detail: 'Usage and costs.',
    icon: Gauge,
  },
  {
    place: 'memories',
    label: 'Memories',
    detail: 'Preferences you share with your Dots.',
    icon: BookOpen,
  },
];

/** Everything that is not part of the day: Dots, Spaces and the technical views. */
export function SettingsView({
  state,
  workspace,
  assistant,
  onAssistant,
  onDot,
  onSpace,
  onPlace,
  onDialog,
}: {
  state: State;
  workspace: WorkspaceState;
  assistant: Dot;
  onAssistant: (dotId: string) => void;
  onDot: (dot: Dot) => void;
  onSpace: (spaceId: string, pageId?: string) => void;
  onPlace: (place: SettingsPlace) => void;
  onDialog: (dialog: Dialog) => void;
}) {
  return (
    <main className="main-content settings-view">
      <div className="page-heading">
        <div>
          <h1>Settings</h1>
          <p>Your assistant, its Dots and Spaces, and the technical views.</p>
        </div>
        <button onClick={() => onDialog({ type: 'settings' })}>
          <Settings2 size={15} />
          Setup and model
        </button>
      </div>

      <section className="settings-section">
        <h2>Assistant</h2>
        <p className="muted">
          The Dot you talk to. It looks into what discovery flags and runs the
          day.
        </p>
        <label className="settings-assistant">
          <span>Assistant</span>
          <select
            value={assistant.id}
            aria-label="Assistant"
            onChange={(event) => onAssistant(event.target.value)}
          >
            {workspace.dots.map((dot) => (
              <option key={dot.id} value={dot.id}>
                {dot.name}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="settings-section">
        <div className="settings-heading">
          <h2>Dots</h2>
          <button
            onClick={() =>
              onDialog({ type: 'dot', spaceId: workspace.spaces[0].id })
            }
          >
            <Plus size={14} />
            New Dot
          </button>
        </div>
        <ul className="settings-list">
          {workspace.dots.map((dot) => (
            <li key={dot.id}>
              <Mascot identity={dot.id} name={dot.name} small decorative />
              <span>
                <strong>{dot.name}</strong>
                {dot.id === assistant.id && <small>Your assistant</small>}
              </span>
              <button onClick={() => onDot(dot)}>
                <MessageCircle size={14} />
                Chat
              </button>
              <button
                className="icon-button"
                aria-label={`Edit ${dot.name} settings`}
                onClick={() =>
                  onDialog({ type: 'dot', dot, spaceId: dot.spaceId })
                }
              >
                <MoreHorizontal size={15} />
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="settings-section">
        <div className="settings-heading">
          <h2>Spaces</h2>
          <button onClick={() => onDialog({ type: 'space' })}>
            <Plus size={14} />
            New Space
          </button>
        </div>
        <nav className="spaces-nav" aria-label="Spaces">
          {workspace.spaces.map((space) => (
            <SpaceNav
              key={space.id}
              space={space}
              active={false}
              onOpen={(pageId) => onSpace(space.id, pageId)}
            />
          ))}
        </nav>
      </section>

      <section className="settings-section">
        <h2>More</h2>
        <ul className="settings-list">
          {places.map(({ place, label, detail, icon: Icon }) => (
            <li key={place}>
              <button className="settings-place" onClick={() => onPlace(place)}>
                <Icon size={17} />
                <span>
                  <strong>{label}</strong>
                  <small>{detail}</small>
                </span>
                {place === 'tasks' && state.tasks.length > 0 && (
                  <small>{state.tasks.length}</small>
                )}
                {place === 'memories' && state.memories.length > 0 && (
                  <small>{state.memories.length}</small>
                )}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
