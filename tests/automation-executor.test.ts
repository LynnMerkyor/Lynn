import { expect, it, vi } from 'vitest';
import { executeLightweightAutomation } from '../lib/desk/automation-executor.js';
import { normalizeAutomationExecutor } from '../shared/automation-executor.js';
import { Scheduler } from '../hub/scheduler.js';
it('preserves legacy agent jobs and executes reminders without a tool or model', async () => {
  const execute = vi.fn(); const options = { signal: new AbortController().signal, tools: [{ name: 'sample.send', _pluginId: 'sample', execute }] };
  expect(await executeLightweightAutomation({ prompt: 'legacy' }, options)).toBeNull();
  expect(await executeLightweightAutomation({ prompt: '该喝水了', executor: { kind: 'reminder' } }, options)).toBe('该喝水了');
  expect(execute).not.toHaveBeenCalled();
});
it('uses exactly the selected plugin action and fails explicitly when absent or unsuccessful', async () => {
  const execute = vi.fn(async () => ({ done: true }));
  const job = { prompt: 'export', executor: { kind: 'plugin_action', pluginId: 'sample', toolName: 'sample.export', input: { format: 'csv' } } };
  const options = { signal: new AbortController().signal, tools: [{ name: 'sample.export', _pluginId: 'sample', execute }] };
  expect(await executeLightweightAutomation(job, options)).toBe('{"done":true}'); expect(execute).toHaveBeenCalledWith({ format: 'csv' });
  await expect(executeLightweightAutomation(job, { ...options, tools: [] })).rejects.toThrow('unavailable');
  await expect(executeLightweightAutomation(job, { ...options, tools: [{ ...options.tools[0], execute: async () => ({ isError: true }) }] })).rejects.toThrow('failed');
  expect(() => normalizeAutomationExecutor({ ...job.executor, toolName: 'other.export' })).toThrow();
});
it('records manual reminder history and emits a desktop notification without an agent turn', async () => {
  const job = { id: 'job_1', enabled: true, label: 'Drink water', prompt: '喝水', executor: { kind: 'reminder' } };
  const logRun = vi.fn(); const emit = vi.fn(); const add = vi.fn();
  const scheduler = new Scheduler({ hub: { engine: { getAgent: () => ({ cronStore: { getJob: () => job, logRun } }), getActivityStore: () => ({ add }), pluginManager: { getAllTools: () => [] } }, eventBus: { emit } } as any });
  scheduler.triggerCronJob('agent-a', 'job_1');
  await vi.waitFor(() => expect(logRun).toHaveBeenCalledWith('job_1', expect.objectContaining({ status: 'success', timestamp: expect.any(String) })));
  expect(add).toHaveBeenCalledWith(expect.objectContaining({ summary: '喝水', sessionFile: null }));
  expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'notification', body: '喝水' }), null);
});
