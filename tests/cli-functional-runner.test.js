import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

async function runFixture(source, limits) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lynn-cli-deadline-test-'));
  const cli = path.join(directory, 'fixture.mjs');
  const output = path.join(directory, 'report.json');
  try {
    await fs.writeFile(cli, source);
    const status = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['scripts/cli-50-dialogue-runner.mjs', '--cli', cli, '--mode', 'ambient', '--only', '1', '--output', output, ...limits], { cwd: path.resolve(import.meta.dirname, '..'), stdio: 'ignore', windowsHide: true });
      child.once('error', reject);
      child.once('exit', resolve);
    });
    return { status, report: JSON.parse(await fs.readFile(output, 'utf8')) };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

describe('CLI functional runner process deadlines', () => {
  it('keeps a real process alive with useful chunks and still requires a final answer', async () => {
    const result = await runFixture(`const emit = event => console.log(JSON.stringify(event)); const timer = setInterval(() => emit({type:'reasoning.delta',text:'thinking'}), 30); setTimeout(() => {clearInterval(timer);emit({type:'assistant.delta',text:'OK'});}, 300);`, ['--timeout-ms', '2000', '--first-chunk-timeout-ms', '1000', '--idle-timeout-ms', '200']);
    expect(result.status).toBe(0);
    expect(result.report.results[0]).toMatchObject({ status: 'ok', assistantText: 'OK', timedOut: false });
    expect(result.report.timeouts.totalMs).toBe(2000);
  });

  it('does not let usage heartbeats prevent an idle timeout', async () => {
    const result = await runFixture(`console.log(JSON.stringify({type:'reasoning.delta',text:'started'}));setInterval(() => console.log(JSON.stringify({type:'usage',usage:{}})), 20);`, ['--timeout-ms', '2000', '--first-chunk-timeout-ms', '1000', '--idle-timeout-ms', '120']);
    expect(result.status).toBe(1);
    expect(result.report.results[0]).toMatchObject({ status: 'timeout', timeoutKind: 'idle', reason: 'idle timeout' });
  });

  it('terminates a silent process with a first chunk diagnosis', async () => {
    const result = await runFixture('setInterval(() => {}, 1000);', ['--timeout-ms', '2000', '--first-chunk-timeout-ms', '200', '--idle-timeout-ms', '120']);
    expect(result.status).toBe(1);
    expect(result.report.results[0]).toMatchObject({ status: 'timeout', timeoutKind: 'first_chunk' });
  });

  it('enforces an explicit total cap despite sustained reasoning', async () => {
    const result = await runFixture(`setInterval(() => console.log(JSON.stringify({type:'reasoning.delta',text:'thinking'})), 20);`, ['--timeout-ms', '400', '--first-chunk-timeout-ms', '1000', '--idle-timeout-ms', '200']);
    expect(result.status).toBe(1);
    expect(result.report.results[0]).toMatchObject({ status: 'timeout', timeoutKind: 'total' });
  });
});
