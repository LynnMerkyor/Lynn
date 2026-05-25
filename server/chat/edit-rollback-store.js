export function createEditRollbackStore(opts = {}) {
  const maxSnapshots = Math.max(1, Number(opts.maxSnapshots || 200));
  const pendingEditSnapshots = new Map();
  const rollbackSnapshots = new Map();
  const rollbackOrder = [];

  return {
    get(rollbackId) {
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

      return rollbackSnapshots.get(rollbackId);
    },
  };
}
