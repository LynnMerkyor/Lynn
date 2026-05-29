/**
 * TaskBriefForm — author a worker brief and dispatch it (B-line).
 * Posts to POST /api/fleet/dispatch; the server FleetHub broadcasts fleet events
 * back over the WS, so a dispatched worker appears on the board with no extra wiring.
 *
 * Supports MiMo vision dispatch (task type + image) and fan-out: one brief dispatched
 * to several agents in parallel (each gets its own worker + worktree).
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

type FleetTaskType = 'code' | 'see' | 'ground' | 'ui2code';

interface FleetDispatchFormState {
  title: string;
  agent: string;
  taskType: FleetTaskType;
  image: string;
  objective: string;
  owned: string;
  forbidden: string;
  tests: string;
  branch: string;
  worktree: string;
}

const FALLBACK_AGENTS: AgentEntry[] = [
  { id: 'lynn-cli', label: 'Lynn CLI', enabled: true },
  { id: 'mimo-vl', label: 'MiMo Vision (mimo-v2.5)', enabled: true },
  { id: 'mimo-pro', label: 'MiMo Pro (long-endurance)', enabled: true },
  { id: 'mimo-fast', label: 'MiMo Fast', enabled: true },
  { id: 'stepfun-flash', label: 'StepFun 3.7 Flash (fast coding)', enabled: true },
  { id: 'codex-cli', label: 'Codex', enabled: true },
  { id: 'claude-code', label: 'Claude Code', enabled: true },
  { id: 'claude-internal', label: 'Claude (internal)', enabled: true },
  { id: 'qwen-cli', label: 'Qwen', enabled: true },
  { id: 'codebuddy', label: 'CodeBuddy', enabled: true },
];

const DEFAULT_FLEET_AGENT = 'lynn-cli';
const INITIAL_SCOPE_DEFAULTS = buildPresetDefaults(DEFAULT_FLEET_SCOPE_PRESET, '');

function toLines(value: string): string[] {
  return value
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function isVisionTask(taskType: FleetTaskType): boolean {
  return taskType === 'see' || taskType === 'ground' || taskType === 'ui2code';
}

export function buildFleetDispatchPayload(state: FleetDispatchFormState) {
  return {
    title: state.title,
    agent: state.agent,
    taskType: state.taskType,
    ...(state.image.trim() ? { image: state.image.trim() } : {}),
    objective: state.objective,
    owned: toLines(state.owned),
    forbidden: toLines(state.forbidden),
    testCommands: toLines(state.tests),
    branch: state.branch,
    worktree: state.worktree,
  };
}

export function TaskBriefForm({ onClose }: { onClose: () => void }) {
  const [agents, setAgents] = useState<AgentEntry[]>(FALLBACK_AGENTS);
  const [title, setTitle] = useState('');
  const [agent, setAgent] = useState(DEFAULT_FLEET_AGENT);
  const [scopePresetId, setScopePresetId] = useState(DEFAULT_FLEET_SCOPE_PRESET.id);
  const [taskType, setTaskType] = useState<FleetTaskType>('code');
  const [fanOut, setFanOut] = useState<string[]>([]);
  const [image, setImage] = useState('');
  const [objective, setObjective] = useState('');
  const [owned, setOwned] = useState(INITIAL_SCOPE_DEFAULTS.owned);
  const [forbidden, setForbidden] = useState(INITIAL_SCOPE_DEFAULTS.forbidden);
  const [tests, setTests] = useState(INITIAL_SCOPE_DEFAULTS.tests);
  const [branch, setBranch] = useState(INITIAL_SCOPE_DEFAULTS.branch);
  const [worktree, setWorktree] = useState(INITIAL_SCOPE_DEFAULTS.worktree);
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

  const isVision = isVisionTask(taskType);
  const writesFiles = taskType === 'code' || taskType === 'ui2code';
  const targets = Array.from(new Set([agent, ...fanOut.filter((a) => a !== agent)]));
  const baseBranch = branch || (isVision ? `vision/${taskType}` : '');
  const baseWorktree = worktree || (isVision ? `worktrees/vision-${taskType}` : '');
  const canSubmit = !!title.trim() && !!baseBranch.trim() && !!baseWorktree.trim() && (!isVision || !!image.trim());

  const setTaskKind = (value: FleetTaskType) => {
    setTaskType(value);
    if (isVisionTask(value) && !agent.startsWith('mimo-')) setAgent('mimo-vl');
    if (value === 'code' && agent === 'mimo-vl') setAgent(DEFAULT_FLEET_AGENT);
  };

  const applyScopePreset = (presetId: string) => {
    const preset = FLEET_SCOPE_PRESETS.find((p) => p.id === presetId) || DEFAULT_FLEET_SCOPE_PRESET;
    const defaults = buildPresetDefaults(preset, title);
    setScopePresetId(preset.id);
    setOwned(defaults.owned);
    setForbidden(defaults.forbidden);
    setTests(defaults.tests);
    setBranch(defaults.branch);
    setWorktree(defaults.worktree);
  };

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      const fan = targets.length > 1;
      for (const target of targets) {
        const brief = buildFleetDispatchPayload({
          title,
          agent: target,
          taskType,
          image,
          objective,
          owned: writesFiles ? owned : '',
          forbidden: writesFiles ? forbidden : '',
          tests: writesFiles ? tests : '',
          branch: fan && baseBranch ? `${baseBranch}-${target}` : baseBranch,
          worktree: fan && baseWorktree ? `${baseWorktree}-${target}` : baseWorktree,
        });
        const res = await hanaFetch('/api/fleet/dispatch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(brief),
        });
        const data = await res.json();
        if (!res.ok || data.error) {
          setError(`${target}: ${data.error || `dispatch failed (${res.status})`}`);
          return;
        }
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
        <label className={s.formLabel}>Title</label>
        <input className={s.formInput} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Split ComposerTextarea" />
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
          <label className={s.formLabel}>Task type</label>
          <select className={s.formInput} value={taskType} onChange={(e) => setTaskKind(e.target.value as FleetTaskType)}>
            <option value="code">Code / text work</option>
            <option value="see">MiMo see image</option>
            <option value="ground">MiMo ground UI element</option>
            <option value="ui2code">MiMo UI to code</option>
          </select>
        </div>
      </div>

      <div className={s.formField}>
        <label className={s.formLabel}>Scope preset</label>
        <select className={s.formInput} value={scopePresetId} onChange={(e) => applyScopePreset(e.target.value)}>
          {FLEET_SCOPE_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
        </select>
        <div className={s.formHint}>
          {FLEET_SCOPE_PRESETS.find((preset) => preset.id === scopePresetId)?.description || DEFAULT_FLEET_SCOPE_PRESET.description}
        </div>
      </div>

      {agents.length > 1 && (
        <div className={s.formField}>
          <label className={s.formLabel}>Fan out to (parallel, optional)</label>
          <div className={s.fanOutRow}>
            {agents
              .filter((a) => a.id !== agent)
              .map((a) => (
                <label key={a.id} className={s.fanOutChip}>
                  <input
                    type="checkbox"
                    checked={fanOut.includes(a.id)}
                    onChange={(e) =>
                      setFanOut((prev) => (e.target.checked ? [...prev, a.id] : prev.filter((x) => x !== a.id)))
                    }
                  />
                  {a.label}
                </label>
              ))}
          </div>
        </div>
      )}

      {isVision && (
        <div className={s.formField}>
          <label className={s.formLabel}>Image path</label>
          <input
            className={s.formInput}
            value={image}
            onChange={(e) => setImage(e.target.value)}
            placeholder="/Users/lynn/Desktop/screenshot.png"
          />
          <div className={s.formHint}>The path is passed to `Lynn worker run`; the CLI reads the image locally and routes it through MiMo vision.</div>
        </div>
      )}
      <div className={s.formRow}>
        <div className={s.formField}>
          <label className={s.formLabel}>Branch</label>
          <input className={s.formInput} value={branch} onChange={(e) => setBranch(e.target.value)} placeholder={isVision ? baseBranch : 'cli-2/inputarea'} />
        </div>
      </div>
      <div className={s.formField}>
        <label className={s.formLabel}>Worktree</label>
        <input className={s.formInput} value={worktree} onChange={(e) => setWorktree(e.target.value)} placeholder={isVision ? baseWorktree : 'worktrees/cli-2-inputarea'} />
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
        <button className={s.fleetBtn} onClick={submit} disabled={busy || !canSubmit}>
          {busy ? 'Dispatching...' : targets.length > 1 ? `Dispatch to ${targets.length} workers` : 'Dispatch worker'}
        </button>
        <button className={s.fleetBtn} onClick={onClose} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}
