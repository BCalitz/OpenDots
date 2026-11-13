import { useEffect, useState } from 'react';
import type { DiscoverySettings, DiscoveryState } from '../shared/inbox-types';
import { api } from './api';

const list = (value: string) =>
  value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);

/**
 * When discovery reaches the owner, who may say an item can be ignored,
 * and in which apps a Dot may propose actions.
 */
export function DiscoverySettingsForm({
  state,
  onSaved,
}: {
  state: DiscoveryState;
  onSaved: () => unknown;
}) {
  const [form, setForm] = useState<DiscoverySettings>(state.settings);
  const [trusted, setTrusted] = useState(state.settings.trusted.join(', '));
  const [apps, setApps] = useState(state.settings.allowedApps.join(', '));
  const [quiet, setQuiet] = useState(!!state.settings.quietHours);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    setForm(state.settings);
    setTrusted(state.settings.trusted.join(', '));
    setApps(state.settings.allowedApps.join(', '));
    setQuiet(!!state.settings.quietHours);
  }, [state.settings]);
  const set = <K extends keyof DiscoverySettings>(
    key: K,
    value: DiscoverySettings[K],
  ) => setForm((current) => ({ ...current, [key]: value }));
  const save = async () => {
    setMessage('');
    setError('');
    try {
      await api('/discovery/settings', 'PUT', {
        ...form,
        quietHours: quiet
          ? (form.quietHours ?? { start: '22:00', end: '07:00' })
          : null,
        trusted: list(trusted),
        allowedApps: list(apps).map((app) => app.toLowerCase()),
      });
      setMessage('Saved.');
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <form
      className="discovery-settings"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h2 className="insight-subhead">When discovery tells you</h2>
      <p className="muted">
        Items needed within hours push at once. Items for today push after a
        short hold, so a quick follow-up can cancel them. The rest, and anything
        in quiet hours, wait for the morning brief.
      </p>
      <div className="field-pair">
        <label>
          <span className="field-label">Morning brief at</span>
          <input
            type="time"
            value={form.briefTime}
            required
            onChange={(e) => set('briefTime', e.target.value)}
          />
        </label>
        <label>
          <span className="field-label">Hold before pushing (minutes)</span>
          <input
            type="number"
            min={0}
            max={120}
            value={form.holdMinutes}
            onChange={(e) => set('holdMinutes', Number(e.target.value))}
          />
        </label>
      </div>
      <label className="permission-row inline">
        <input
          type="checkbox"
          checked={quiet}
          onChange={(e) => setQuiet(e.target.checked)}
        />
        <span>Quiet hours: only “within hours” items break through</span>
      </label>
      {quiet && (
        <div className="field-pair">
          <label>
            <span className="field-label">From</span>
            <input
              type="time"
              value={form.quietHours?.start ?? '22:00'}
              onChange={(e) =>
                set('quietHours', {
                  start: e.target.value,
                  end: form.quietHours?.end ?? '07:00',
                })
              }
            />
          </label>
          <label>
            <span className="field-label">Until</span>
            <input
              type="time"
              value={form.quietHours?.end ?? '07:00'}
              onChange={(e) =>
                set('quietHours', {
                  start: form.quietHours?.start ?? '22:00',
                  end: e.target.value,
                })
              }
            />
          </label>
        </div>
      )}
      <label>
        <span className="field-label">Time zone</span>
        <input
          value={form.timeZone}
          onChange={(e) => set('timeZone', e.target.value)}
          placeholder="Africa/Johannesburg"
        />
      </label>
      <label>
        <span className="field-label">
          Your addresses and organisation domains
        </span>
        <input
          value={trusted}
          onChange={(e) => setTrusted(e.target.value)}
          placeholder="you@example.com, example.com"
        />
      </label>
      <p className="muted small">
        Besides an item’s own sender, only these may say it can be ignored, so a
        stranger’s “never mind” can’t hide a real invoice. Mail between these
        domains also isn’t treated as related just for sharing the domain.
      </p>
      <label>
        <span className="field-label">
          Apps where a Dot may propose actions
        </span>
        <input
          value={apps}
          onChange={(e) => setApps(e.target.value)}
          placeholder="gmail, jira"
        />
      </label>
      <p className="muted small">
        App names: gmail, outlook or teams. In these apps a Dot drafts the
        action for you to approve; elsewhere it only tells you what is needed,
        where and who asked. Nothing is allowed until you add it.
      </p>
      <label>
        <span className="field-label">Keep full item text for (days)</span>
        <input
          type="number"
          min={1}
          max={365}
          value={form.retentionDays}
          onChange={(e) => set('retentionDays', Number(e.target.value))}
        />
      </label>
      <p className="muted small">
        Every day OpenDots notes what each item said about the people,
        companies, invoices and projects in it, then removes the item’s full
        text after this many days. Items still waiting on you are kept.
      </p>
      <p className="muted small">
        Similar items:{' '}
        {state.embeddings.configured
          ? `on, with ${state.embeddings.model}.`
          : 'off. Set EMBEDDING_BASE_URL (for example a local Ollama) to find items with similar wording.'}
      </p>
      <div className="discovery-settings-actions">
        <button className="primary" type="submit">
          Save
        </button>
        {message && (
          <span className="muted" role="status">
            {message}
          </span>
        )}
        {error && <span className="chat-error">{error}</span>}
      </div>
    </form>
  );
}
