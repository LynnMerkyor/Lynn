#!/usr/bin/env node
// CI-only, bounded public runtime archive check. Never fetch model weights.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
const require = createRequire(import.meta.url);
const { selectRuntimeAsset, safeArchiveEntry } = require('../desktop/llamacpp-runtime-installer.cjs');
const exec = promisify(execFile);
if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.RUNNER_TEMP) throw new Error('This download gate is restricted to GitHub native CI, never the work Mac');
const asset = selectRuntimeAsset();
if (!asset) throw new Error(`Unsupported native CI target ${process.platform}/${process.arch}`);
const temp = await fs.mkdtemp(path.join(process.env.RUNNER_TEMP, 'lynn-dflash-contract-'));
const report = { platform: process.platform, arch: process.arch, archive: asset.name, expectedBytes: asset.size, expectedSha256: asset.sha256, gpuModelLoadTest: false };
try {
  const archive = path.join(temp, asset.name);
  const response = await fetch(asset.url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok || !response.body) throw new Error(`Runtime HTTP ${response.status}`);
  const hash = createHash('sha256');
  let bytes = 0;
  const verify = new Transform({ transform(chunk, _enc, cb) {
    bytes += chunk.length;
    if (bytes > asset.size) return cb(new Error('Runtime exceeds pinned byte size'));
    hash.update(chunk); cb(null, chunk);
  } });
  await pipeline(Readable.fromWeb(response.body), verify, createWriteStream(archive, { flags: 'wx' }));
  const sha256 = hash.digest('hex');
  if (bytes !== asset.size || sha256 !== asset.sha256) throw new Error('Runtime archive verification failed');
  Object.assign(report, { bytes, sha256 });
  const output = path.join(temp, 'extracted');
  await fs.mkdir(output);
  const opts = { timeout: 60000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 };
  if (asset.name.endsWith('.zip')) {
    const q = text => `'${text.replaceAll("'", "''")}'`;
    await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath ${q(archive)} -DestinationPath ${q(output)}`], opts);
  } else {
    const list = await exec('tar', ['-tzf', archive], opts);
    if (list.stdout.split(/\r?\n/).filter(Boolean).some(entry => !safeArchiveEntry(entry))) throw new Error('Unsafe tar entry');
    await exec('tar', ['-xzf', archive, '-C', output], opts);
  }
  async function find(dir, depth = 0) {
    if (depth > 4) return null;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    if (entries.length > 512) throw new Error('Archive file limit exceeded');
    for (const e of entries) if (e.isFile() && /^llama-server(?:\.exe)?$/.test(e.name)) return path.join(dir, e.name);
    for (const e of entries) if (e.isDirectory()) { const found = await find(path.join(dir, e.name), depth + 1); if (found) return found; }
    return null;
  }
  const binary = await find(output);
  if (!binary) throw new Error('llama-server missing from archive');
  const version = await exec(binary, ['--version'], opts);
  const help = await exec(binary, ['--help'], opts);
  const text = help.stdout + help.stderr;
  const required = ['draft-dflash', '--model-draft', '--spec-draft-n-max', '--spec-draft-n-min', '--gpu-layers-draft'];
  for (const flag of required) if (!text.includes(flag)) throw new Error(`Runtime missing ${flag}`);
  Object.assign(report, { version: (version.stdout + version.stderr).trim(), requiredFlags: required, passed: true });
  console.log(`PASS ${process.platform}/${process.arch}: exact archive hash and native DFlash2 command contract; no GPU model loading claimed`);
} catch (error) {
  Object.assign(report, { passed: false, error: error.message });
  process.exitCode = 1;
} finally {
  await fs.mkdir('output/local-model-runtime', { recursive: true });
  await fs.writeFile(`output/local-model-runtime/${process.platform}-${process.arch}.json`, JSON.stringify(report, null, 2));
  await fs.rm(temp, { recursive: true, force: true });
}
