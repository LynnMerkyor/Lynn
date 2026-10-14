export function isGuiTurnActivity(event) {
  if (event?.type === 'text_delta' || event?.type === 'thinking_delta') {
    return typeof event.delta === 'string' && event.delta.length > 0;
  }
  if (event?.type === 'tool_progress') {
    return Boolean(event.name) && (event.event === 'start' || event.event === 'end');
  }
  return ['tool_start', 'tool_end', 'tool_execution_start', 'tool_execution_end'].includes(event?.type);
}

export function createGuiTurnDeadline({ firstChunkMs, idleMs, totalMs = 0, onTimeout }) {
  for (const [name, value] of Object.entries({ firstChunkMs, idleMs, totalMs })) {
    if (!Number.isFinite(value) || value < 0 || (name !== 'totalMs' && value === 0)) {
      throw new Error(`Invalid GUI deadline ${name}: ${value}`);
    }
  }
  let firstTimer = null;
  let idleTimer = null;
  let totalTimer = null;
  let stopped = false;
  const stop = () => {
    stopped = true;
    clearTimeout(firstTimer);
    clearTimeout(idleTimer);
    clearTimeout(totalTimer);
  };
  const expire = kind => {
    if (stopped) return;
    stop();
    onTimeout(kind);
  };
  firstTimer = setTimeout(() => expire('first_chunk'), firstChunkMs);
  if (totalMs > 0) totalTimer = setTimeout(() => expire('total'), totalMs);
  return {
    stop,
    activity() {
      if (stopped) return;
      clearTimeout(firstTimer);
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => expire('idle'), idleMs);
    },
  };
}
