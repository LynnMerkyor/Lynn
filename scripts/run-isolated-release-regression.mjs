import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveBetterSqliteRuntime } from './native-node-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lynn-release-isolated-'));
const infoPath = path.join(home, 'server-info.json');
const runtime = resolveBetterSqliteRuntime({ cwd: root, env: process.env });
const server = spawn(runtime.bin, [...runtime.argsPrefix, '--import', 'tsx', 'server/index.ts'], {
  cwd: root,
  env: { ...runtime.env, LYNN_HOME: home, HANA_PORT: '0', LYNN_IMPORT_HANAKO_ON_FIRST_RUN: '0', LYNN_SKIP_LLAMACPP: '1' },
  stdio: ['ignore', 'ignore', 'ignore'],
});
let runner;
let serverError;
let interrupted = false;
server.on('error', error => { serverError = error; });
const interrupt = () => {
  interrupted = true;
  runner?.kill('SIGTERM');
  server.kill('SIGTERM');
};
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

try {
  console.log(`[isolated-release] server PID=${server.pid}; temporary session directory`);
  const deadline = Date.now() + 60_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (interrupted) throw new Error('Isolated release regression interrupted');
    if (serverError) throw serverError;
    if (server.exitCode !== null || server.signalCode !== null) throw new Error('Isolated release server exited before readiness');
    try {
      const info = JSON.parse(await fs.readFile(infoPath, 'utf8'));
      const port = Number(info.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535 || !info.token) throw new Error('Invalid isolated server metadata');
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        headers: { Authorization: `Bearer ${info.token}` }, signal: AbortSignal.timeout(2000),
      });
      ready = response.ok;
      await response.body?.cancel();
      if (ready) break;
    } catch {}
    await sleep(250);
  }
  if (!ready) throw new Error('Isolated release server readiness timed out');
  const code = await new Promise((resolve, reject) => {
    runner = spawn(process.execPath, ['scripts/run-release-regression.mjs', ...process.argv.slice(2), '--server-info', infoPath], {
      cwd: root, env: { ...process.env, LYNN_HOME: home }, stdio: 'inherit',
    });
    runner.once('error', reject);
    runner.once('exit', result => resolve(result ?? 1));
  });
  process.exitCode = interrupted ? 1 : code;
} finally {
  server.kill('SIGTERM');
  const deadline = Date.now() + 5000;
  while (server.exitCode === null && server.signalCode === null && !serverError && Date.now() < deadline) await sleep(100);
  if (server.exitCode === null && server.signalCode === null && !serverError) server.kill('SIGKILL');
  await fs.rm(home, { recursive: true, force: true });
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', interrupt);
}
