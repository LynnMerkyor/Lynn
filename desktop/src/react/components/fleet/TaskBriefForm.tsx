/**
 * TaskBriefForm — author a worker brief and dispatch it (B-line).
 * Posts to POST /api/fleet/dispatch; the server FleetHub broadcasts fleet events
 * back over the WS, so a dispatched worker appears on the board with no extra wiring.
 */
import { useEffect, useState } from 'react';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import s from './Fleet.module.css';
import { DEFAULT_FLEET_SCOPE_PRESET, FLEET_SCOPE_PRESETS, buildPresetDefaults } from './brief-presets';

interface AgentEntry {
  id: string;
  label: string;
  enabled: boolean;
}

const FALLBACK_AGENTS: AgentEntry[] = [
  { id: 'lynn-cli', label: 'Lynn CLI', enabled: true },
  { id: 'codex-cli', label: 'Codex', enabled: true },
  { id: 'claude-code', label: 'Claude Code', enabled: true },
  { id: 'claude-internal', label: 'Claude (internal)', enabled: true },
  { id: 'qwen-cli', label: 'Qwen', enabled: true },
];

function toLines(value: string): string[] {
  return value
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

export function TaskBriefForm({ onClose }: { onClose: () => void }) {
  const [agents, setAgents] = useState<AgentEntry[]>(FALLBACK_AGENTS);
  const [presetId, setPresetId] = useState(DEFAULT_FLEET_SCOPE_PRESET.id);
  const [title, setTitle] = useState('');
  const [agent, setAgent] = useState('claude-code');
  const [objective, setObjective] = useState('');
  const initialDefaults = buildPresetDefaults(DEFAULT_FLEET_SCOPE_PRESET, '');
  const [owned, setOwned] = useState(initialDefaults.owned);
  const [forbidden, setForbidden] = useState(initialDefaults.forbidden);
  const [tests, setTests] = useState(initialDefaults.tests);
  const [branch, setBranch] = useState(initialDefaults.branch);
  const [worktree, setWorktree] = useState(initialDefaults.worktree);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    hanaFetch('/api/fleet/registry')
      .then((r) => r.json())
      .then((d) => {
        if (alive && Array.isArray(d.agents)) {
          setAgents(d.agents.filter((a: AgentEntry) => a.enabled));
        }
      })
      .catch(() => {
        /* keep fallback list */
      });
    return () => {
      alive = false;
    };
  }, []);

  const applyPreset = (nextPresetId: string, nextTitle = title) => {
    const preset = FLEET_SCOPE_PRESETS.find((p) => p.id === nextPresetId) ?? DEFAULT_FLEET_SCOPE_PRESET;
    const defaults = buildPresetDefaults(preset, nextTitle);
    setPresetId(preset.id);
    setOwned(defaults.owned);
    setForbidden(defaults.forbidden);
    setTests(defaults.tests);
    setBranch(defaults.branch);
    setWorktree(defaults.worktree);
  };

  const refreshGeneratedNames = () => {
    const preset = FLEET_SCOPE_PRESETS.find((p) => p.id === presetId) ?? DEFAULT_FLEET_SCOPE_PRESET;
    const defaults = buildPresetDefaults(preset, title);
    setBranch(defaults.branch);
    setWorktree(defaults.worktree);
  };

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      const brief = {
        title,
        agent,
        objective,
        owned: toLines(owned),
        forbidden: toLines(forbidden),
        testCommands: toLines(tests),
        branch,
        worktree,
      };
      const res = await hanaFetch('/api/fleet/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(brief),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setError(data.error || `dispatch failed (${res.status})`);
        return;
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={s.briefForm}>
      <div className={s.formField}>
        <label className={s.formLabel}>Scope preset</label>
        <select className={s.formInput} value={presetId} onChange={(e) => applyPreset(e.target.value)}>
          {FLEET_SCOPE_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <div className={s.formHint}>{FLEET_SCOPE_PRESETS.find((p) => p.id === presetId)?.description}</div>
      </div>
      <div className={s.formField}>
        <label className={s.formLabel}>Title</label>
        <input
          className={s.formInput}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={refreshGeneratedNames}
          placeholder="Split ComposerTextarea"
        />
      </div>
      <div className={s.formRow}>
        <div className={s.formField}>
          <label className={s.formLabel}>Agent</label>
          <select className={s.formInput} value={agent} onChange={(e) => setAgent(e.target.value)}>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </div>
        <div className={s.formField}>
          <label className={s.formLabel}>Branch</label>
          <input className={s.formInput} value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="cli-2/inputarea" />
        </div>
      </div>
      <div className={s.formField}>
        <label className={s.formLabel}>Worktree</label>
        <input className={s.formInput} value={worktree} onChange={(e) => setWorktree(e.target.value)} placeholder="worktrees/cli-2-inputarea" />
      </div>
      <div className={s.formField}>
        <label className={s.formLabel}>Objective</label>
        <textarea className={s.formTextarea} value={objective} onChange={(e) => setObjective(e.target.value)} rows={2} />
      </div>
      <div className={s.formRow}>
        <div className={s.formField}>
          <label className={s.formLabel}>Owned files (one glob per line)</label>
          <textarea
            className={s.formTextarea}
            value={owned}
            onChange={(e) => setOwned(e.target.value)}
            rows={3}
            placeholder="desktop/src/react/components/input/**"
          />
        </div>
        <div className={s.formField}>
          <label className={s.formLabel}>Forbidden files</label>
          <textarea className={s.formTextarea} value={forbidden} onChange={(e) => setForbidden(e.target.value)} rows={3} />
        </div>
      </div>
      <div className={s.formField}>
        <label className={s.formLabel}>Test commands (one per line)</label>
        <textarea className={s.formTextarea} value={tests} onChange={(e) => setTests(e.target.value)} rows={2} />
      </div>
      {error && <div className={s.formError}>{error}</div>}
      <div className={s.formActions}>
        <button className={s.fleetBtn} onClick={refreshGeneratedNames} disabled={busy || !title} type="button">
          Regenerate names
        </button>
        <button className={s.fleetBtn} onClick={submit} disabled={busy || !title || !branch || !worktree}>
          {busy ? 'Dispatching…' : 'Dispatch worker'}
        </button>
        <button className={s.fleetBtn} onClick={onClose} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}
