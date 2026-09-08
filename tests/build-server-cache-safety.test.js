import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Exercise the real build entrypoint: invalid cache placement must fail before
// output cleanup, including a cache nested inside the directory being removed.
describe('offline build dependency cache safety', () => {
  it.each(['same', 'nested', 'symlink'])('preserves cache contents for a %s output alias', (kind) => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'lynn-build-cache-'));
    try {
      const output = path.join(fixture, 'dist-server', 'mac-arm64');
      fs.mkdirSync(path.join(fixture, 'scripts'), { recursive: true });
      fs.mkdirSync(output, { recursive: true });
      fs.copyFileSync(path.join(process.cwd(), 'scripts/build-server.mjs'), path.join(fixture, 'scripts/build-server.mjs'));
      fs.symlinkSync(path.join(process.cwd(), 'node_modules'), path.join(fixture, 'node_modules'), 'junction');
      let cacheRoot = path.dirname(output);
      if (kind === 'nested') {
        cacheRoot = path.join(output, 'cache');
        fs.mkdirSync(path.join(cacheRoot, 'mac-arm64'), { recursive: true });
      } else if (kind === 'symlink') {
        cacheRoot = path.join(fixture, 'cache-alias');
        fs.mkdirSync(cacheRoot);
        fs.symlinkSync(output, path.join(cacheRoot, 'mac-arm64'), 'junction');
      }
      const sentinel = path.join(output, 'keep.txt');
      fs.writeFileSync(sentinel, 'verified existing cache');
      const child = spawnSync(process.execPath, [path.join(fixture, 'scripts/build-server.mjs'), 'darwin', 'arm64'], {
        cwd: fixture,
        env: { ...process.env, LYNN_BUILD_OFFLINE: '1', LYNN_BUILD_DEPS_ROOT: cacheRoot },
        encoding: 'utf8', timeout: 10000,
      });
      expect(child.status).toBe(1);
      expect(child.stderr).toContain('Dependency source must be separate');
      expect(fs.readFileSync(sentinel, 'utf8')).toBe('verified existing cache');
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});
