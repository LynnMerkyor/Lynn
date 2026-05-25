export interface EditRollbackSnapshot {
  sessionPath?: string;
  streamToken?: string | null;
  cwd?: string;
  filePath?: string;
  originalContent?: string;
  [key: string]: unknown;
}

export interface FinalizedEditRollbackSnapshot extends EditRollbackSnapshot {
  rollbackId: string;
  createdAt: number;
}

interface EditRollbackStoreOptions {
  maxSnapshots?: number;
}

export interface EditRollbackStore {
  get(rollbackId: string | null | undefined): FinalizedEditRollbackSnapshot | null;
  setPending(toolCallId: string | null | undefined, snapshot: EditRollbackSnapshot | null | undefined): void;
  discardPending(toolCallId: string | null | undefined): void;
  discardPendingForSession(sessionPath: string | null | undefined, streamToken?: string | null): number;
  pendingCount(): number;
  finalize(toolCallId: string | null | undefined): FinalizedEditRollbackSnapshot | null;
}

export function createEditRollbackStore(opts: EditRollbackStoreOptions = {}): EditRollbackStore {
  const maxSnapshots = Math.max(1, Number(opts.maxSnapshots || 200));
  const pendingEditSnapshots = new Map<string, EditRollbackSnapshot>();
  const rollbackSnapshots = new Map<string, FinalizedEditRollbackSnapshot>();
  const rollbackOrder: string[] = [];

  return {
    get(rollbackId) {
      if (!rollbackId) return null;
      return rollbackSnapshots.get(rollbackId) || null;
    },
    setPending(toolCallId, snapshot) {
      if (!toolCallId || !snapshot) return;
      pendingEditSnapshots.set(toolCallId, snapshot);
    },
    discardPending(toolCallId) {
      if (!toolCallId) return;
      pendingEditSnapshots.delete(toolCallId);
    },
    discardPendingForSession(sessionPath, streamToken = null) {
      if (!sessionPath) return 0;
      let count = 0;
      for (const [toolCallId, snapshot] of pendingEditSnapshots) {
        if (snapshot?.sessionPath !== sessionPath) continue;
        if (streamToken && snapshot?.streamToken && snapshot.streamToken !== streamToken) continue;
        pendingEditSnapshots.delete(toolCallId);
        count += 1;
      }
      return count;
    },
    pendingCount() {
      return pendingEditSnapshots.size;
    },
    finalize(toolCallId) {
      if (!toolCallId) return null;
      const snapshot = pendingEditSnapshots.get(toolCallId);
      pendingEditSnapshots.delete(toolCallId);
      if (!snapshot) return null;

      const rollbackId = toolCallId;
      if (!rollbackSnapshots.has(rollbackId)) rollbackOrder.push(rollbackId);
      rollbackSnapshots.set(rollbackId, {
        rollbackId,
        createdAt: Date.now(),
        ...snapshot,
      });

      while (rollbackOrder.length > maxSnapshots) {
        const oldestId = rollbackOrder.shift();
        if (oldestId) rollbackSnapshots.delete(oldestId);
      }

      return rollbackSnapshots.get(rollbackId) || null;
    },
  };
}
