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

export function WorkersPanel() {
  const activePanel = useStore((st) => st.activePanel);
  const fleetWorkers = useStore((st) => st.fleetWorkers);
  const applyFleetEvent = useStore((st) => st.applyFleetEvent);
  const resetFleet = useStore((st) => st.resetFleet);
  const cancelRef = useRef<null | (() => void)>(null);
  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    return () => {
      if (cancelRef.current) cancelRef.current();
    };
  }, []);

  if (activePanel !== 'fleet') return null;

  const close = () => useStore.getState().setActivePanel(null);

  const playMock = () => {
    if (cancelRef.current) cancelRef.current();
    resetFleet();
    cancelRef.current = playFleetFixture(MOCK_WORKER_JSONL, applyFleetEvent, { intervalMs: 250 });
  };

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
          <div className={s.fleetToolbar}>
            <button className={s.fleetBtn} onClick={() => setShowForm((v) => !v)}>
              {showForm ? 'Close form' : 'Dispatch worker'}
            </button>
            <button className={s.fleetBtn} onClick={playMock}>
              Play mock worker
            </button>
            <span className={s.fleetHint}>{fleetWorkers.length} worker(s)</span>
          </div>

          {showForm && <TaskBriefForm onClose={() => setShowForm(false)} />}

          {fleetWorkers.length === 0 ? (
            <div className={s.fleetEmpty}>No workers yet. Dispatch one, or play a mock stream.</div>
          ) : (
            <div className={s.fleetBoard}>
              {fleetWorkers.map((w) => (
                <WorkerCard key={w.workerId} worker={w} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
