import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PROBE_SCRIPT = `
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.close();
`;

function probeRuntime(bin, env, cwd) {
  const result = spawnSync(bin, ['-e', PROBE_SCRIPT], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 15_000,
  });
  return {
    ok: result.status === 0,
    error: String(result.stderr || result.error?.message || '').trim(),
  };
}

export function resolveBetterSqliteRuntime({ cwd = process.cwd(), env = process.env } = {}) {
  const nodeEnv = { ...env };
  delete nodeEnv.ELECTRON_RUN_AS_NODE;
  const nodeProbe = probeRuntime(process.execPath, nodeEnv, cwd);
  if (nodeProbe.ok) {
    return { kind: 'node', bin: process.execPath, env: nodeEnv, argsPrefix: [] };
  }

  let electronBin = '';
  try {
    electronBin = require('electron');
  } catch {
    throw new Error(`better-sqlite3 is incompatible with the current Node runtime: ${nodeProbe.error}`);
  }
  const electronEnv = { ...env, ELECTRON_RUN_AS_NODE: '1' };
  const electronProbe = probeRuntime(electronBin, electronEnv, cwd);
  if (electronProbe.ok) {
    return { kind: 'electron-node', bin: electronBin, env: electronEnv, argsPrefix: [] };
  }

  throw new Error([
    'No available runtime can load better-sqlite3.',
    `Node: ${nodeProbe.error || 'probe failed'}`,
    `Electron Node: ${electronProbe.error || 'probe failed'}`,
  ].join('\n'));
}
