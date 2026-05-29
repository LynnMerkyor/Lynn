import { describe, expect, it } from 'vitest';
import { createWorkerView, reduceFleetWorker, summarizeFleetUsage } from '../fleet-reducer';

// The server attaches structured context to worker.progress.data (an existing
// protocol field) for B1 vision + B3 runner, so the GUI can render them without a
// shared protocol change.
describe('worker.progress data (vision + runner context)', () => {
  it('captures vision taskType + image from data:{kind:vision}', () => {
    let v = createWorkerView('w1', 'mimo-vl');
    v = reduceFleetWorker(v, {
      type: 'worker.progress',
      workerId: 'w1',
      message: 'vision task: ground',
      data: { kind: 'vision', taskType: 'ground', image: '/shot.png' },
    });
    expect(v.taskType).toBe('ground');
    expect(v.image).toBe('/shot.png');
  });

  it('captures runner mode + source + pid from data:{kind:runner}', () => {
    let v = createWorkerView('w1');
    v = reduceFleetWorker(v, {
      type: 'worker.progress',
      workerId: 'w1',
      message: 'spawned via bundled Node (pid 7)',
      data: { kind: 'runner', mode: 'spawned', source: 'bundled', pid: 7 },
    });
    expect(v.runner).toEqual({ mode: 'spawned', source: 'bundled', pid: 7 });
  });

  it('stub runner data sets mode stub', () => {
    let v = createWorkerView('w1');
    v = reduceFleetWorker(v, {
      type: 'worker.progress',
      workerId: 'w1',
      message: 'stub - CLI bundle pending',
      data: { kind: 'runner', mode: 'stub' },
    });
    expect(v.runner?.mode).toBe('stub');
  });

  it('plain progress without data is just a log line', () => {
    let v = createWorkerView('w1');
    v = reduceFleetWorker(v, { type: 'worker.progress', workerId: 'w1', message: 'hello' });
    expect(v.log).toContain('hello');
    expect(v.taskType).toBeUndefined();
    expect(v.runner).toBeUndefined();
  });

  it('captures structured worker.visual_result events', () => {
    let v = createWorkerView('w1', 'mimo-vl');
    v = reduceFleetWorker(v, {
      type: 'worker.visual_result',
      workerId: 'w1',
      agent: 'mimo-vl',
      taskType: 'ground',
      image: '/shot.png',
      summary: 'Button is at bottom right.',
      boxes: [{ label: 'Submit', x: 0.7, y: 0.8, width: 0.1, height: 0.05 }],
      files: [{ path: 'desktop/src/react/App.tsx', kind: 'suggested' }],
    });

    expect(v.taskType).toBe('ground');
    expect(v.image).toBe('/shot.png');
    expect(v.visualResult).toEqual({
      taskType: 'ground',
      image: '/shot.png',
      summary: 'Button is at bottom right.',
      boxes: [{ label: 'Submit', x: 0.7, y: 0.8, width: 0.1, height: 0.05 }],
      files: [{ path: 'desktop/src/react/App.tsx', kind: 'suggested' }],
    });
  });

  it('tracks tool started and finished events as structured tool runs', () => {
    let v = createWorkerView('w1');
    v = reduceFleetWorker(v, {
      type: 'tool.started',
      workerId: 'w1',
      name: 'read_file',
      argsPreview: '{"path":"README.md"}',
    });
    expect(v.tools).toEqual([
      { name: 'read_file', argsPreview: '{"path":"README.md"}', running: true },
    ]);

    v = reduceFleetWorker(v, {
      type: 'tool.finished',
      workerId: 'w1',
      name: 'read_file',
      ok: true,
      ms: 12,
    });
    expect(v.tools).toEqual([
      { name: 'read_file', argsPreview: '{"path":"README.md"}', running: false, ok: true, ms: 12 },
    ]);
  });

  it('records unmatched tool finished events without losing failures', () => {
    const v = reduceFleetWorker(createWorkerView('w1'), {
      type: 'tool.finished',
      workerId: 'w1',
      name: 'bash',
      ok: false,
      ms: 33,
    });
    expect(v.tools).toEqual([{ name: 'bash', running: false, ok: false, ms: 33 }]);
  });

  it('summarizes usage progress data for token and cache visibility', () => {
    expect(summarizeFleetUsage({
      prompt_tokens: 1000,
      completion_tokens: 120,
      total_tokens: 1120,
      prompt_cache_hit_tokens: 850,
      duration_ms: 2000,
    })).toMatchObject({
      summary: '1120 tok · in 1000 · out 120 · cache 850 (85%) · 60.0 TPS',
      cacheRatio: 85,
      tps: 60,
    });

    let v = createWorkerView('w1');
    v = reduceFleetWorker(v, {
      type: 'worker.progress',
      workerId: 'w1',
      message: 'usage',
      data: {
        prompt_cache_hit_tokens: 90,
        prompt_cache_miss_tokens: 10,
        completion_tokens: 44,
        durationMs: 200,
      },
    });
    expect(v.usage).toMatchObject({ summary: 'out 44 · cache 90 (90%) · 220 TPS', cacheRatio: 90, tps: 220 });
  });

  it('summarizes nested cached-token provider usage shapes', () => {
    expect(summarizeFleetUsage({
      input_tokens: 1000,
      output_tokens: 200,
      prompt_tokens_details: { cached_tokens: 750 },
      duration_ms: 1000,
    })).toMatchObject({
      summary: '1200 tok · in 1000 · out 200 · cache 750 (75%) · 200 TPS',
      cacheRatio: 75,
      tps: 200,
    });
  });
});
