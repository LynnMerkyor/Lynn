/**
 * fixtures.ts — a representative worker JSONL stream for GUI mock playback.
 *
 * Deliberately includes a forbidden-file edit + a worker.violation so the panel
 * exercises the out-of-scope red flag and the "finished but blocked" state. Each
 * line is real protocol JSON, parsed through parseFleetJsonLine on playback.
 */
export const MOCK_WORKER_ID = 'mock-1';

export const MOCK_WORKER_JSONL: string = [
  {
    schemaVersion: 1,
    type: 'worker.started',
    workerId: MOCK_WORKER_ID,
    agent: 'claude-code',
    cwd: '/repo',
    worktree: 'worktrees/cli-2-inputarea',
    branch: 'cli-2/inputarea-split',
    pid: 48211,
    approval: 'on-failure',
    sandbox: 'workspace-write',
  },
  {
    type: 'worker.claims',
    workerId: MOCK_WORKER_ID,
    owned: ['desktop/src/react/components/input/**'],
    forbidden: ['server/**', 'brain-v2-mirror/**'],
    centerLocks: ['server/routes/chat.ts'],
  },
  { type: 'worker.progress', workerId: MOCK_WORKER_ID, message: 'Extracted ComposerTextarea from InputArea' },
  { type: 'tool.started', workerId: MOCK_WORKER_ID, name: 'read_file', argsPreview: 'InputArea.tsx' },
  { type: 'tool.finished', workerId: MOCK_WORKER_ID, name: 'read_file', ok: true, ms: 12 },
  { type: 'shell.started', workerId: MOCK_WORKER_ID, command: 'npm test -- input', approval: 'auto' },
  { type: 'test.started', workerId: MOCK_WORKER_ID, command: 'npm test -- input' },
  { type: 'test.finished', workerId: MOCK_WORKER_ID, command: 'npm test -- input', ok: true, ms: 1840, summary: '42 passed' },
  { type: 'shell.finished', workerId: MOCK_WORKER_ID, command: 'npm test -- input', exitCode: 0, ok: true, ms: 1900 },
  { type: 'file.changed', workerId: MOCK_WORKER_ID, path: 'desktop/src/react/components/input/ComposerTextarea.tsx', action: 'add' },
  {
    type: 'git.diff',
    workerId: MOCK_WORKER_ID,
    files: 3,
    insertions: 70,
    deletions: 41,
    changedFiles: [
      { path: 'desktop/src/react/components/input/ComposerTextarea.tsx', action: 'add', insertions: 58, deletions: 0 },
      { path: 'desktop/src/react/components/InputArea.tsx', action: 'edit', insertions: 12, deletions: 40 },
      { path: 'server/routes/chat.ts', action: 'edit', insertions: 0, deletions: 1, forbidden: true, centerLocked: true },
    ],
  },
  {
    type: 'worker.violation',
    workerId: MOCK_WORKER_ID,
    code: 'forbidden_file',
    message: 'edited forbidden path server/routes/chat.ts',
    path: 'server/routes/chat.ts',
    severity: 'error',
  },
  {
    type: 'worker.finished',
    workerId: MOCK_WORKER_ID,
    ok: true,
    exitCode: 0,
    summary: 'Split ComposerTextarea; tests green',
    commit: 'ab12cd3',
  },
]
  .map((event) => JSON.stringify(event))
  .join('\n');
