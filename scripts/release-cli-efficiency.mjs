import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function releaseEfficiencyPlan() {
  return ['low', 'high'].flatMap(reasoning => {
    const fast = reasoning === 'low';
    return [
      {
        id: `${reasoning}-routes`, reasoning,
        script: 'scripts/cli-route-latency-smoke.mjs',
        args: ['--reasoning', reasoning, '--stepfun-runs', '3', '--spark-runs', '1',
          '--timeout-ms', fast ? '30000' : '660000', '--min-stepfun-success-rate', '1',
          ...(fast ? ['--max-stepfun-p50-ttft-ms', '2500', '--max-stepfun-p50-wall-ms', '4000'] : [])],
      },
      {
        id: `${reasoning}-efficiency`, reasoning,
        script: 'scripts/cli-efficiency-gate.mjs',
        args: ['--reasoning', reasoning, '--live', '--suite', 'smoke', '--repeat', '1',
          '--timeout-ms', fast ? '240000' : '660000', '--min-success-rate', '1',
          '--max-waste-steps', '0', '--max-max-steps-reached', '0',
          ...(fast ? ['--max-p50-ttft-ms', '2500', '--max-p50-wall-ms', '4500'] : [])],
      },
    ];
  });
}

export function profilePassed(profile, exitCode, report) {
  if (exitCode !== 0 || report?.reasoning !== profile.reasoning || report?.gate?.pass !== true) return false;
  const rows = profile.id.endsWith('-routes') ? report.stepfun : report.results;
  return Array.isArray(rows) && rows.length === 3 && rows.every(row =>
    row.reasoning === profile.reasoning && (profile.id.endsWith('-routes') ? row.ok === true : row.success === true));
}

export function validReleaseEfficiencyPlan(plan) {
  if (!Array.isArray(plan) || plan.length !== 4) return false;
  return ['low', 'high'].every(reasoning => ['routes', 'efficiency'].every(kind => {
    const id = `${reasoning}-${kind}`;
    const matches = plan.filter(profile => profile?.id === id);
    if (matches.length !== 1) return false;
    const profile = matches[0];
    const routes = kind === 'routes';
    const fast = reasoning === 'low';
    if (profile.reasoning !== reasoning || profile.script !== (routes ? 'scripts/cli-route-latency-smoke.mjs' : 'scripts/cli-efficiency-gate.mjs') || !Array.isArray(profile.args)) return false;
    const required = routes ? {
      '--reasoning': reasoning, '--stepfun-runs': '3', '--spark-runs': '1',
      '--timeout-ms': fast ? '30000' : '660000', '--min-stepfun-success-rate': '1',
      ...(fast ? { '--max-stepfun-p50-ttft-ms': '2500', '--max-stepfun-p50-wall-ms': '4000' } : {}),
    } : {
      '--reasoning': reasoning, '--live': null, '--suite': 'smoke', '--repeat': '1',
      '--timeout-ms': fast ? '240000' : '660000', '--min-success-rate': '1',
      '--max-waste-steps': '0', '--max-max-steps-reached': '0',
      ...(fast ? { '--max-p50-ttft-ms': '2500', '--max-p50-wall-ms': '4500' } : {}),
    };
    const flags = profile.args.filter(arg => typeof arg === 'string' && arg.startsWith('--'));
    if (flags.length !== Object.keys(required).length || new Set(flags).size !== flags.length) return false;
    return Object.entries(required).every(([flag, value]) => {
      const position = profile.args.indexOf(flag);
      return position >= 0 && (value === null || profile.args[position + 1] === value);
    });
  }));
}

export async function runReleaseEfficiency(directory) {
  if (!validReleaseEfficiencyPlan(releaseEfficiencyPlan())) throw new Error('Release efficiency profile contract is invalid');
  fs.mkdirSync(directory, { recursive: true });
  const results = [];
  for (const profile of releaseEfficiencyPlan()) {
    const reportPath = path.join(directory, `${profile.id}.json`);
    if (fs.existsSync(reportPath)) throw new Error(`Refusing to overwrite ${reportPath}`);
    console.log(`[release-efficiency] START ${profile.id}`);
    const exitCode = await new Promise(resolve => {
      const child = spawn(process.execPath, [profile.script, ...profile.args, '--out', reportPath], { cwd: root, stdio: 'inherit' });
      child.once('error', () => resolve(1));
      child.once('exit', code => resolve(code ?? 1));
    });
    let report = null;
    try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')); } catch {}
    const pass = profilePassed(profile, exitCode, report);
    results.push({ ...profile, exitCode, pass, reportPath });
    console.log(`[release-efficiency] END ${profile.id} ${pass ? 'PASS' : 'FAIL'}`);
  }
  const report = { schema: 'lynn-release-efficiency-profiles-v1', checkedAt: new Date().toISOString(), pass: results.every(result => result.pass), results };
  fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`[release-efficiency] report ${path.join(directory, 'summary.json')}`);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = fs.mkdtempSync(path.join(root, 'output/release-efficiency-profiles-'));
  const report = await runReleaseEfficiency(directory);
  process.exitCode = report.pass ? 0 : 1;
}
