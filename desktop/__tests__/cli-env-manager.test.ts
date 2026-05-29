import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

// cli-env-manager is a CommonJS main-process module (.cjs); load it via Node's
// require (vite's resolver does not include .cjs in its default extensions).
const nodeRequire = createRequire(import.meta.url);
const { resolveCliRuntime, detectSystemNode, parseNodeMajor, getWorkerSpawnCommand } =
  nodeRequire('../cli-env-manager.cjs');

const existsIn = (set: string[]) => (p: string) => set.includes(p);

describe('resolveCliRuntime', () => {
  it('reuses the real bundled server node on mac/linux (0 extra bytes)', () => {
    const rt = resolveCliRuntime({
      platform: 'darwin',
      execPath: '/Applications/Lynn.app/Contents/MacOS/Lynn',
      resourcesPath: '/res',
      fileExists: existsIn(['/res/server/node', '/res/cli/lynn.mjs']),
    });
    expect(rt.nodeSource).toBe('bundled');
    expect(rt.node).toBe('/res/server/node');
    expect(rt.electronAsNode).toBe(false);
    expect(rt.canRunInApp).toBe(true);
  });

  it('falls back to electron-as-node on windows (server ships a SEA, not node)', () => {
    const rt = resolveCliRuntime({
      platform: 'win32',
      execPath: 'C:/Lynn/Lynn.exe',
      resourcesPath: 'C:/res',
      fileExists: existsIn(['C:/res/cli/lynn.mjs']),
    });
    expect(rt.nodeSource).toBe('electron');
    expect(rt.electronAsNode).toBe(true);
    expect(rt.node).toBe('C:/Lynn/Lynn.exe');
    expect(rt.canRunInApp).toBe(true);
  });

  it('canRunInApp is false until the CLI bundle is shipped', () => {
    const rt = resolveCliRuntime({
      platform: 'darwin',
      execPath: '/e',
      resourcesPath: '/res',
      appRoot: '/app',
      fileExists: existsIn(['/res/server/node']),
    });
    expect(rt.cliPresent).toBe(false);
    expect(rt.canRunInApp).toBe(false);
  });

  it('finds the dev CLI build when extraResources is absent', () => {
    const rt = resolveCliRuntime({
      platform: 'darwin',
      execPath: '/e',
      resourcesPath: '/res',
      appRoot: '/repo',
      fileExists: existsIn(['/res/server/node', '/repo/cli/bin/lynn.mjs']),
    });
    expect(rt.cliEntry).toBe('/repo/cli/bin/lynn.mjs');
    expect(rt.canRunInApp).toBe(true);
  });
});

describe('detectSystemNode', () => {
  it('parses `which node` + `node --version`', () => {
    const fakeSpawn = (cmd: string, args: string[]) => {
      if (cmd === 'which') return { stdout: '/usr/local/bin/node\n' };
      if (args && args[0] === '--version') return { stdout: 'v22.16.0\n' };
      return { stdout: '' };
    };
    expect(detectSystemNode({ platform: 'darwin', spawnSync: fakeSpawn })).toEqual({
      path: '/usr/local/bin/node',
      version: 'v22.16.0',
      major: 22,
    });
  });

  it('returns null when no node is on PATH', () => {
    expect(detectSystemNode({ platform: 'darwin', spawnSync: () => ({ stdout: '' }) })).toBeNull();
  });
});

describe('parseNodeMajor', () => {
  it('extracts the major version', () => {
    expect(parseNodeMajor('v22.16.0')).toBe(22);
    expect(parseNodeMajor('20.1.0')).toBe(20);
    expect(parseNodeMajor('garbage')).toBeNull();
  });
});

describe('getWorkerSpawnCommand', () => {
  it('returns null until the CLI bundle is present', () => {
    expect(
      getWorkerSpawnCommand(['worker', 'run'], {
        platform: 'darwin',
        execPath: '/e',
        resourcesPath: '/res',
        fileExists: () => false,
      }),
    ).toBeNull();
  });

  it('builds an electron-as-node command with ELECTRON_RUN_AS_NODE=1', () => {
    const cmd = getWorkerSpawnCommand(['worker', 'run', '--jsonl'], {
      platform: 'win32',
      execPath: 'C:/Lynn/Lynn.exe',
      resourcesPath: 'C:/res',
      fileExists: (p: string) => p === 'C:/res/cli/lynn.mjs',
    });
    expect(cmd).not.toBeNull();
    expect(cmd.command).toBe('C:/Lynn/Lynn.exe');
    expect(cmd.args).toEqual(['C:/res/cli/lynn.mjs', 'worker', 'run', '--jsonl']);
    expect(cmd.env.ELECTRON_RUN_AS_NODE).toBe('1');
  });
});
