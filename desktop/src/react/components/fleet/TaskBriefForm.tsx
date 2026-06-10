/**
 * TaskBriefForm — author a worker brief and dispatch it (B-line).
 * Posts to POST /api/fleet/dispatch; the server FleetHub broadcasts fleet events
 * back over the WS, so a dispatched worker appears on the board with no extra wiring.
 *
 * Supports vision dispatch (task type + image) and fan-out: one brief dispatched
 * to several agents in parallel (each gets its own worker + worktree).
 */
import { useEffect, useState } from 'react';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import s from './Fleet.module.css';
import { DEFAULT_FLEET_SCOPE_PRESET, FLEET_SCOPE_PRESETS, buildPresetDefaults } from './brief-presets';
import { CANONICAL_FLEET_AGENTS, guiFallbackAgents } from '../../../../../shared/fleet-agents.js';

interface AgentEntry {
  id: string;
  label: string;
  enabled: boolean;
  available?: boolean;
  availability?: string;
}

type FleetTaskType = 'code' | 'see' | 'ground' | 'ui2code';
type FleetApprovalMode = 'ask' | 'on-failure' | 'never' | 'yolo';
type FleetSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

interface FleetDispatchFormState {
  title: string;
  agent: string;
  taskType: FleetTaskType;
  image: string;
  approval: FleetApprovalMode;
  sandbox: FleetSandboxMode;
  objective: string;
  owned: string;
  forbidden: string;
  tests: string;
  branch: string;
  worktree: string;
}

// Agent 名单的唯一事实源在 shared/fleet-agents.ts;这里只取 GUI 兜底投影
//(/api/fleet/registry 拉不到时展示 fleet 可派单项)。
const FALLBACK_AGENTS: AgentEntry[] = guiFallbackAgents();

const DEFAULT_FLEET_AGENT = 'lynn-cli';
// Vision tasks route through StepFun (step-1o-turbo-vision via the wire adapter).
const VISION_FLEET_AGENT = 'stepfun-flash';
const INITIAL_SCOPE_DEFAULTS = buildPresetDefaults(DEFAULT_FLEET_SCOPE_PRESET, '');
const EXTERNAL_AGENT_IDS = new Set(
  CANONICAL_FLEET_AGENTS.filter((agent) => agent.kind === 'external' && !agent.serverOnly).map((agent) => String(agent.id)),
);

function toLines(value: string): string[] {
  return value
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function isVisionTask(taskType: FleetTaskType): boolean {
  return taskType === 'see' || taskType === 'ground' || taskType === 'ui2code';
}

export function agentOptionLabel(agent: AgentEntry): string {
  if (agent.enabled) return agent.label;
  return `${agent.label} (${agent.availability || 'unavailable'})`;
}

export function isExternalFleetAgent(agentId: string): boolean {
  return EXTERNAL_AGENT_IDS.has(agentId);
}

export function externalTargetsNeedFullAccess(input: {
  targets: string[];
  approval: FleetApprovalMode;
  sandbox: FleetSandboxMode;
}): boolean {
  return input.targets.some(isExternalFleetAgent)
    && !(input.approval === 'yolo' && input.sandbox === 'danger-full-access');
}

export function buildFleetDispatchPayload(state: FleetDispatchFormState) {
  return {
    title: state.title,
    agent: state.agent,
    taskType: state.taskType,
    ...(state.image.trim() ? { image: state.image.trim() } : {}),
    approval: state.approval,
    sandbox: state.sandbox,
    objective: state.objective,
    owned: toLines(state.owned),
    forbidden: toLines(state.forbidden),
    testCommands: toLines(state.tests),
    branch: state.branch,
    worktree: state.worktree,
  };
}

export function TaskBriefForm({ onClose }: { onClose: () => void }) {
  const t = window.t ?? ((k: string) => k);
  const tf = (k: string, fallback: string, vars?: Record<string, string | number>) => {
    const v = t(`fleet.form.${k}`, vars);
    return v && v !== `fleet.form.${k}` ? v : fallback;
  };
  const [agents, setAgents] = useState<AgentEntry[]>(FALLBACK_AGENTS);
  const [title, setTitle] = useState('');
  const [agent, setAgent] = useState(DEFAULT_FLEET_AGENT);
  const [scopePresetId, setScopePresetId] = useState(DEFAULT_FLEET_SCOPE_PRESET.id);
  const [taskType, setTaskType] = useState<FleetTaskType>('code');
  const [approval, setApproval] = useState<FleetApprovalMode>('ask');
  const [sandbox, setSandbox] = useState<FleetSandboxMode>('workspace-write');
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
          const nextAgents = d.agents as AgentEntry[];
          setAgents(nextAgents);
          if (!nextAgents.some((a) => a.id === agent && a.enabled)) {
            const fallback = nextAgents.find((a) => a.enabled);
            if (fallback) setAgent(fallback.id);
          }
        }
      })
      .catch(() => {
        /* keep fallback list */
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    hanaFetch('/api/fleet/permissions')
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        if (d?.approval === 'ask' || d?.approval === 'on-failure' || d?.approval === 'never' || d?.approval === 'yolo') {
          setApproval(d.approval);
        }
        if (d?.sandbox === 'read-only' || d?.sandbox === 'workspace-write' || d?.sandbox === 'danger-full-access') {
          setSandbox(d.sandbox);
        }
      })
      .catch(() => {
        /* keep guarded defaults */
      });
    return () => {
      alive = false;
    };
  }, []);

  const isVision = isVisionTask(taskType);
  const writesFiles = taskType === 'code' || taskType === 'ui2code';
  const targets = Array.from(new Set([agent, ...fanOut.filter((a) => a !== agent)]));
  const needsExternalFullAccess = externalTargetsNeedFullAccess({ targets, approval, sandbox });
  const baseBranch = branch || (isVision ? `vision/${taskType}` : '');
  const baseWorktree = worktree || (isVision ? `worktrees/vision-${taskType}` : '');
  const canSubmit = !!title.trim() && !!baseBranch.trim() && !!baseWorktree.trim() && (!isVision || !!image.trim()) && !needsExternalFullAccess;

  const setTaskKind = (value: FleetTaskType) => {
    setTaskType(value);
    if (isVisionTask(value) && agent !== VISION_FLEET_AGENT) setAgent(VISION_FLEET_AGENT);
    if (value === 'code' && agent === VISION_FLEET_AGENT) setAgent(DEFAULT_FLEET_AGENT);
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
          approval,
          sandbox,
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
        <label className={s.formLabel}>{tf('title', 'Title')}</label>
        <input className={s.formInput} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={tf('titlePlaceholder', 'Split ComposerTextarea')} />
      </div>
      <div className={s.formRow}>
        <div className={s.formField}>
          <label className={s.formLabel}>{tf('agent', 'Agent')}</label>
          <select className={s.formInput} value={agent} onChange={(e) => setAgent(e.target.value)}>
            {agents.map((a) => (
              <option key={a.id} value={a.id} disabled={!a.enabled}>
                {agentOptionLabel(a)}
              </option>
            ))}
          </select>
          <div className={s.formHint}>{agents.find((a) => a.id === agent)?.availability || tf('ready', 'Ready')}</div>
        </div>
        <div className={s.formField}>
          <label className={s.formLabel}>{tf('taskType', 'Task type')}</label>
          <select className={s.formInput} value={taskType} onChange={(e) => setTaskKind(e.target.value as FleetTaskType)}>
            <option value="code">{tf('taskTypeCode', 'Code / text work')}</option>
            <option value="see">{tf('taskTypeSee', 'See image')}</option>
            <option value="ground">{tf('taskTypeGround', 'Ground UI element')}</option>
            <option value="ui2code">{tf('taskTypeUi2code', 'UI to code')}</option>
          </select>
        </div>
      </div>

      <div className={s.formField}>
        <label className={s.formLabel}>{tf('scopePreset', 'Scope preset')}</label>
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
          <label className={s.formLabel}>{tf('fanOut', 'Fan out to (parallel, optional)')}</label>
          <div className={s.fanOutRow}>
            {agents
              .filter((a) => a.id !== agent && a.enabled)
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
          <label className={s.formLabel}>{tf('imagePath', 'Image path')}</label>
          <input
            className={s.formInput}
            value={image}
            onChange={(e) => setImage(e.target.value)}
            placeholder="/Users/lynn/Desktop/screenshot.png"
          />
          <div className={s.formHint}>{tf('imageHint', 'The path is passed to `Lynn worker run`; the CLI reads the image locally and routes it through a vision-capable model.')}</div>
        </div>
      )}
      <div className={s.formRow}>
        <div className={s.formField}>
          <label className={s.formLabel}>{tf('approval', 'Approval')}</label>
          <select className={s.formInput} value={approval} onChange={(e) => setApproval(e.target.value as FleetApprovalMode)}>
            <option value="ask">{tf('approvalAsk', 'ask (guarded)')}</option>
            <option value="on-failure">{tf('approvalOnFailure', 'on-failure')}</option>
            <option value="never">{tf('approvalNever', 'never (read/check only)')}</option>
            <option value="yolo">{tf('approvalYolo', 'yolo (autonomous edits)')}</option>
          </select>
          <div className={approval === 'yolo' ? s.formDangerHint : s.formHint}>
            {approval === 'yolo'
              ? tf('approvalHintYolo', 'YOLO lets the worker edit files and run shell tools without another prompt.')
              : tf('approvalHintGuarded', 'Non-interactive workers may stop before dangerous edits unless approval is yolo.')}
          </div>
        </div>
        <div className={s.formField}>
          <label className={s.formLabel}>{tf('sandbox', 'Sandbox')}</label>
          <select className={s.formInput} value={sandbox} onChange={(e) => setSandbox(e.target.value as FleetSandboxMode)}>
            <option value="read-only">read-only</option>
            <option value="workspace-write">workspace-write</option>
            <option value="danger-full-access">danger-full-access</option>
          </select>
          <div className={sandbox === 'danger-full-access' ? s.formDangerHint : s.formHint}>
            {sandbox === 'danger-full-access'
              ? tf('sandboxHintFull', 'Full filesystem access is only for trusted local worktrees.')
              : tf('sandboxHintScoped', 'Workspace-write keeps edits scoped to the assigned worktree.')}
          </div>
        </div>
      </div>
      {targets.some(isExternalFleetAgent) && (
        <div className={needsExternalFullAccess ? s.formDangerHint : s.formHint}>
          {tf('externalHint', 'External CLI adapters run their own shell/process. To launch them from Fleet, explicitly set Approval=yolo and Sandbox=danger-full-access. Built-in Lynn and StepFun workers can stay guarded.')}
        </div>
      )}
      <div className={s.formRow}>
        <div className={s.formField}>
          <label className={s.formLabel}>{tf('branch', 'Branch')}</label>
          <input className={s.formInput} value={branch} onChange={(e) => setBranch(e.target.value)} placeholder={isVision ? baseBranch : 'cli-2/inputarea'} />
        </div>
      </div>
      <div className={s.formField}>
        <label className={s.formLabel}>{tf('worktree', 'Worktree')}</label>
        <input className={s.formInput} value={worktree} onChange={(e) => setWorktree(e.target.value)} placeholder={isVision ? baseWorktree : 'worktrees/cli-2-inputarea'} />
      </div>
      <div className={s.formField}>
        <label className={s.formLabel}>{tf('objective', 'Objective')}</label>
        <textarea className={s.formTextarea} value={objective} onChange={(e) => setObjective(e.target.value)} rows={2} />
      </div>
      <div className={s.formRow}>
        <div className={s.formField}>
          <label className={s.formLabel}>{tf('owned', 'Owned files (one glob per line)')}</label>
          <textarea
            className={s.formTextarea}
            value={owned}
            onChange={(e) => setOwned(e.target.value)}
            rows={3}
            placeholder="desktop/src/react/components/input/**"
          />
        </div>
        <div className={s.formField}>
          <label className={s.formLabel}>{tf('forbidden', 'Forbidden files')}</label>
          <textarea className={s.formTextarea} value={forbidden} onChange={(e) => setForbidden(e.target.value)} rows={3} />
        </div>
      </div>
      <div className={s.formField}>
        <label className={s.formLabel}>{tf('tests', 'Test commands (one per line)')}</label>
        <textarea className={s.formTextarea} value={tests} onChange={(e) => setTests(e.target.value)} rows={2} />
      </div>
      {error && <div className={s.formError}>{error}</div>}
      <div className={s.formActions}>
        <button className={s.fleetBtn} onClick={submit} disabled={busy || !canSubmit}>
          {busy
            ? tf('dispatching', 'Dispatching...')
            : targets.length > 1
              ? tf('dispatchN', `Dispatch to ${targets.length} workers`, { count: targets.length })
              : (t('fleet.dispatch') !== 'fleet.dispatch' ? t('fleet.dispatch') : 'Dispatch worker')}
        </button>
        <button className={s.fleetBtn} onClick={onClose} disabled={busy}>
          {tf('cancel', 'Cancel')}
        </button>
      </div>
    </div>
  );
}
