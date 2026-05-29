import { describe, expect, it } from 'vitest';
import { collectFleetEvents } from '../playback';
import { applyFleetEventToList, type FleetWorkerView } from '../fleet-reducer';
import { MOCK_WORKER_ID, MOCK_WORKER_JSONL } from '../fixtures';

describe('fleet mock playback', () => {
  it('parses every fixture line as a valid fleet event', () => {
    const { events, skipped } = collectFleetEvents(MOCK_WORKER_JSONL);
    expect(skipped).toEqual([]);
    expect(events.length).toBeGreaterThan(10);
  });

  it('reduces the mock stream into one worker view with the expected end state', () => {
    const { events } = collectFleetEvents(MOCK_WORKER_JSONL);
    let list: FleetWorkerView[] = [];
    for (const ev of events) list = applyFleetEventToList(list, ev);

    expect(list).toHaveLength(1);
    const w = list[0];
    expect(w.workerId).toBe(MOCK_WORKER_ID);
    expect(w.agent).toBe('claude-code');
    expect(w.branch).toBe('cli-2/inputarea-split');
    expect(w.diffStat).toEqual({ files: 3, insertions: 70, deletions: 41 });
    expect(w.changedFiles.find((f) => f.path.endsWith('ComposerTextarea.tsx'))?.insertions).toBe(58);
    expect(w.activeFile).toBeUndefined(); // cleared once git.diff/finish lands
    expect(w.tests.some((t) => !t.running && t.ok)).toBe(true);
    expect(w.finished?.ok).toBe(true);
    expect(w.finished?.commit).toBe('ab12cd3');
  });

  it('flags the out-of-scope edit and blocks despite a clean finish', () => {
    const { events } = collectFleetEvents(MOCK_WORKER_JSONL);
    let list: FleetWorkerView[] = [];
    for (const ev of events) list = applyFleetEventToList(list, ev);
    const w = list[0];

    expect(w.hasForbiddenEdit).toBe(true);
    expect(w.changedFiles.some((f) => f.forbidden === true)).toBe(true);
    expect(w.violations.length).toBeGreaterThan(0);
    // finished ok=true, but a forbidden-file breach keeps it blocked (merge stays disabled).
    expect(w.status).toBe('blocked');
  });

  it('ignores events without a workerId rather than crashing', () => {
    const list = applyFleetEventToList([], {
      type: 'worker.progress',
      message: 'orphan',
    } as never);
    expect(list).toEqual([]);
  });
});
