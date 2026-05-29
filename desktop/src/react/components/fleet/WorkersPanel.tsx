/**
 * WorkersPanel — the GUI command deck for the CLI Worker Fleet (B-line, MVP shell).
 *
 * - "Dispatch worker" opens the Task Brief form -> POST /api/fleet/dispatch; the
 *   server FleetHub streams fleet events back over the WS into this board.
 * - "Play mock worker" replays a fixture stream through the same applyFleetEvent
 *   path the live WS uses, so the board is demoable without a running worker.
 */
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../stores';
import fp from '../FloatingPanels.module.css';
import s from './Fleet.module.css';
import { WorkerCard } from './WorkerCard';
import { TaskBriefForm } from './TaskBriefForm';
import { playFleetFixture } from './playback';
import { MOCK_WORKER_JSONL } from './fixtures';
import { detectFleetConflicts } from './fleet-conflicts';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import type { CliEnvStatus } from '../../types';

interface DiffPreviewState {
  workerId: string;
  path: string;
  loading: boolean;
  diff?: string;
  error?: string;
}

export function WorkersPanel() {
  const activePanel = useStore((st) => st.activePanel);
  const fleetWorkers = useStore((st) => st.fleetWorkers);
  const applyFleetEvent = useStore((st) => st.applyFleetEvent);
  const resetFleet = useStore((st) => st.resetFleet);
  const cancelRef = useRef<null | (() => void)>(null);
  const [showForm, setShowForm] = useState(false);
  const [cliEnv, setCliEnv] = useState<CliEnvStatus | null>(null);
  const [diffPreview, setDiffPreview] = useState<DiffPreviewState | null>(null);

  useEffect(() => {
    return () => {
      if (cancelRef.current) cancelRef.current();
    };
  }, []);

  useEffect(() => {
    if (activePanel !== 'fleet') return;
    let alive = true;
    const p = window.hana?.cliEnvStatus?.();
    if (p) p.then((st) => { if (alive) setCliEnv(st); }).catch(() => { /* ipc unavailable */ });
    return () => {
      alive = false;
    };
  }, [activePanel]);

  if (activePanel !== 'fleet') return null;

  const close = () => useStore.getState().setActivePanel(null);

  const playMock = () => {
    if (cancelRef.current) cancelRef.current();
    resetFleet();
    cancelRef.current = playFleetFixture(MOCK_WORKER_JSONL, applyFleetEvent, { intervalMs: 250 });
  };

  const cancelWorker = (workerId: string) => {
    void hanaFetch(`/api/fleet/workers/${encodeURIComponent(workerId)}/cancel`, { method: 'POST' }).catch(() => {
      /* server broadcasts the cancel result; ignore transport errors here */
    });
  };

  const viewDiff = (workerId: string, filePath: string) => {
    setDiffPreview({ workerId, path: filePath, loading: true });
    void hanaFetch(`/api/fleet/workers/${encodeURIComponent(workerId)}/diff?path=${encodeURIComponent(filePath)}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) throw new Error(data.error);
        setDiffPreview({ workerId, path: filePath, loading: false, diff: data.diff || '(no diff)' });
      })
      .catch((e) => setDiffPreview({ workerId, path: filePath, loading: false, error: e instanceof Error ? e.message : String(e) }));
  };

  const conflicts = detectFleetConflicts(fleetWorkers);

  const totals = fleetWorkers.reduce(
    (acc, w) => {
      if (w.diffStat) {
        acc.files += w.diffStat.files;
        acc.ins += w.diffStat.insertions;
        acc.del += w.diffStat.deletions;
      }
      return acc;
    },
    { files: 0, ins: 0, del: 0 },
  );

  return (
    <div className={fp.floatingPanel} onClick={close}>
      <div className={fp.floatingPanelInner} onClick={(e) => e.stopPropagation()}>
        <div className={fp.floatingPanelHeader}>
          <span className={fp.floatingPanelTitle}>Workers</span>
          <button className={fp.floatingPanelClose} onClick={close} aria-label="close">
            ×
          </button>
        </div>
        <div className={fp.floatingPanelBody}>
          {cliEnv && (
            <div className={s.cliEnv} data-ready={cliEnv.ready ? '1' : '0'}>
              CLI runtime: Node {cliEnv.node.version ?? '?'} ({cliEnv.node.source})
              {cliEnv.ready ? ' · ready' : cliEnv.cli.present ? '' : ' · CLI bundle pending integration'}
            </div>
          )}
          <div className={s.fleetToolbar}>
            <button className={s.fleetBtn} onClick={() => setShowForm((v) => !v)}>
              {showForm ? 'Close form' : 'Dispatch worker'}
            </button>
            <button className={s.fleetBtn} onClick={playMock}>
              Play mock worker
            </button>
            <span className={s.fleetHint}>
              {fleetWorkers.length} worker(s)
              {totals.files > 0 && (
                <>
                  {' · '}
                  {totals.files} files <span className={s.fileIns}>+{totals.ins}</span>{' '}
                  <span className={s.fileDel}>-{totals.del}</span>
                </>
              )}
            </span>
          </div>

          {showForm && <TaskBriefForm onClose={() => setShowForm(false)} />}

          {conflicts.length > 0 && (
            <div className={s.conflictBanner}>
              <strong>⚠ {conflicts.length} conflict(s)</strong>
              {conflicts.map((c) => (
                <div key={`${c.kind}:${c.path}`}>
                  {c.kind === 'center-lock' ? 'center-lock' : 'overlap'} · {c.path} · {c.workerIds.join(', ')}
                </div>
              ))}
            </div>
          )}

          {fleetWorkers.length === 0 ? (
            <div className={s.fleetEmpty}>No workers yet. Dispatch one, or play a mock stream.</div>
          ) : (
            <div className={s.fleetBoard}>
              {fleetWorkers.map((w) => (
                <WorkerCard key={w.workerId} worker={w} onCancel={cancelWorker} onViewDiff={viewDiff} />
              ))}
            </div>
          )}

          {diffPreview && (
            <div className={s.diffDrawer}>
              <div className={s.diffDrawerHead}>
                <span>Diff · {diffPreview.path}</span>
                <button className={s.fleetBtn} onClick={() => setDiffPreview(null)}>
                  Close
                </button>
              </div>
              <pre className={s.diffPre}>
                {diffPreview.loading ? 'Loading diff…' : diffPreview.error ? `Error: ${diffPreview.error}` : diffPreview.diff}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
