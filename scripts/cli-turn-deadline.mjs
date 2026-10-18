import { createGuiTurnDeadline, isGuiTurnActivity } from './gui-turn-deadline.mjs';

export const CLI_FUNCTIONAL_TIMEOUTS = Object.freeze({ firstChunkMs: 600000, idleMs: 120000, totalMs: 660000 });

export function isCliTurnActivity(event) {
  if (event?.type === 'assistant.delta' || event?.type === 'reasoning.delta') {
    return typeof event.text === 'string' && event.text.length > 0;
  }
  if (event?.type === 'tool.start' || event?.type === 'tool.end') {
    return Boolean(event.name || event.tool);
  }
  return isGuiTurnActivity(event);
}

export function createCliTurnDeadline(options) {
  return createGuiTurnDeadline({ ...CLI_FUNCTIONAL_TIMEOUTS, ...options });
}
