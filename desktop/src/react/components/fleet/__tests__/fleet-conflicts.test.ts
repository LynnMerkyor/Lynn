import { describe, expect, it } from 'vitest';
import { detectFleetConflicts } from '../fleet-conflicts';
import { createWorkerView, reduceFleetWorker, type FleetWorkerView } from '../fleet-reducer';

function viewWith(
  workerId: string,
  status: FleetWorkerView['status'],
  centerLocks: string[],
  files: string[],
): FleetWorkerView {
  return { ...createWorkerView(workerId), status, centerLocks, changedFiles: files.map((path) => ({ path })) };
}

describe('detectFleetConflicts', () => {
  it('flags center-lock contention between two in-play workers', () => {
    const conflicts = detectFleetConflicts([
      viewWith('w1', 'running', ['server/routes/chat.ts'], []),
      viewWith('w2', 'blocked', ['server/routes/chat.ts'], []),
    ]);
    expect(conflicts.some((c) => c.kind === 'center-lock' && c.path === 'server/routes/chat.ts')).toBe(true);
  });

  it('flags the same actual changed file edited by two workers', () => {
    const conflicts = detectFleetConflicts([
      viewWith('w1', 'running', [], ['core/engine.ts']),
      viewWith('w2', 'waiting_approval', [], ['core/engine.ts']),
    ]);
    const overlap = conflicts.find((c) => c.kind === 'overlap' && c.path === 'core/engine.ts');
    expect(overlap?.workerIds.sort()).toEqual(['w1', 'w2']);
  });

  it('ignores terminal-status workers (no false contention)', () => {
    expect(
      detectFleetConflicts([
        viewWith('w1', 'completed', ['a'], ['f']),
        viewWith('w2', 'failed', ['a'], ['f']),
        viewWith('w3', 'cancelled', ['a'], ['f']),
      ]),
    ).toEqual([]);
  });
});

describe('cancel maps to cancelled status', () => {
  it('worker.error code=cancelled sets status cancelled (not failed)', () => {
    let v = createWorkerView('w1');
    v = reduceFleetWorker(v, { type: 'worker.started', workerId: 'w1', cwd: '/r', worktree: 'wt', branch: 'b' });
    v = reduceFleetWorker(v, { type: 'worker.error', workerId: 'w1', code: 'cancelled', message: 'cancelled by user', recoverable: false });
    expect(v.status).toBe('cancelled');
  });

  it('recoverable worker errors still move the card to failed for retry', () => {
    let v = createWorkerView('w1');
    v = reduceFleetWorker(v, { type: 'worker.started', workerId: 'w1', cwd: '/r', worktree: 'wt', branch: 'b' });
    v = reduceFleetWorker(v, { type: 'worker.error', workerId: 'w1', code: 'worker_exit', message: 'worker exited', recoverable: true });
    expect(v.status).toBe('failed');
    expect(v.error).toMatchObject({ code: 'worker_exit', recoverable: true });
  });
});
