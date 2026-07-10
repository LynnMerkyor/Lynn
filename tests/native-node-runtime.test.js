import { describe, expect, it } from 'vitest';
import { resolveBetterSqliteRuntime } from '../scripts/native-node-runtime.mjs';

describe('native Node runtime selection', () => {
  it('selects a runtime that can load better-sqlite3 without rebuilding it', () => {
    const runtime = resolveBetterSqliteRuntime({ cwd: process.cwd(), env: process.env });
    expect(['node', 'electron-node']).toContain(runtime.kind);
    expect(runtime.bin).toBeTruthy();
  });
});
