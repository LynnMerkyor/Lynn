/**
 * fleet-conflicts.ts — cross-worker conflict detection (B-line, the Claims/Conflict
 * pillar). Pure: given the live worker views, find center-lock contention and
 * same-file overlap among workers that are still in play. Derived from each worker's
 * declared center locks + ACTUAL changed files (not trust-the-worker claims).
 */
import type { FleetWorkerView } from './fleet-reducer';

export interface FleetConflict {
  path: string;
  workerIds: string[];
  kind: 'center-lock' | 'overlap';
}

const IN_PLAY = new Set(['queued', 'running', 'waiting_approval', 'blocked']);

export function detectFleetConflicts(workers: FleetWorkerView[]): FleetConflict[] {
  const active = workers.filter((w) => IN_PLAY.has(w.status));
  const conflicts: FleetConflict[] = [];

  // Center-lock contention: 2+ in-play workers holding the same central file.
  const byLock = new Map<string, string[]>();
  for (const w of active) {
    for (const lock of w.centerLocks) {
      const ids = byLock.get(lock) ?? [];
      ids.push(w.workerId);
      byLock.set(lock, ids);
    }
  }
  for (const [path, ids] of byLock) {
    if (ids.length > 1) conflicts.push({ path, workerIds: ids, kind: 'center-lock' });
  }

  // Overlap: the same actual changed path edited by 2+ in-play workers.
  const byFile = new Map<string, Set<string>>();
  for (const w of active) {
    for (const f of w.changedFiles) {
      const ids = byFile.get(f.path) ?? new Set<string>();
      ids.add(w.workerId);
      byFile.set(f.path, ids);
    }
  }
  for (const [path, ids] of byFile) {
    if (ids.size > 1) conflicts.push({ path, workerIds: [...ids], kind: 'overlap' });
  }

  return conflicts;
}
