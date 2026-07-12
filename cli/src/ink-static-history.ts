export interface InkHistoryItem {
  pending?: boolean;
}

/**
 * Ink Static only supports append-only item lists. Keep every item after the
 * first pending one in the live area so an out-of-order tool completion can
 * never insert into already printed terminal history.
 */
export function splitInkStaticHistory<T extends InkHistoryItem>(items: readonly T[]): {
  settledItems: T[];
  activeItems: T[];
} {
  const firstPendingIndex = items.findIndex((item) => item.pending);
  if (firstPendingIndex < 0) {
    return { settledItems: [...items], activeItems: [] };
  }
  return {
    settledItems: items.slice(0, firstPendingIndex),
    activeItems: items.slice(firstPendingIndex),
  };
}
