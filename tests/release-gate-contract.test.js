import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { selectCases } from '../agent-regression-kit/src/core.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

function readPackage() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
}

describe('release gate contract', () => {
  it('waits for loaded model metadata before measuring packaged main UI', () => {
    const runner = fs.readFileSync(path.join(ROOT, 'scripts/packaged-main-ui-smoke.mjs'), 'utf8');
    expect(runner).toContain("!!button?.title.trim() && !button.className.includes('model-pill-disabled')");
    expect(runner).toContain('60000, "loaded model selector button"');
    expect(runner).toContain('within("modelButton", baseLayout.modelButton, { minWidth: 80, minHeight: 28 })');
  });
  it('covers every gate-bank operation once through preflight instead of repeating wrappers', () => {
    const scripts = readPackage().scripts;
    const chain = ['release:preflight', 'release:full-gate', 'release:overnight'].map(name => scripts[name]).join(' && ');
    expect(chain).not.toContain('test:agent-regression:gates');
    expect(chain).not.toContain('test:agent-regression:nightly');
    const bank = JSON.parse(fs.readFileSync(path.join(ROOT, 'agent-regression-kit/cases/lynn-gates-v1.json'), 'utf8'));
    for (const entry of bank.cases) {
      expect(entry.operation).toBe('command_gate');
      for (const step of entry.input.steps) {
        if (step.packageScript === 'test') {
          expect(scripts['release:preflight']).toContain('npm run test:release:root');
          for (const file of step.args.filter(arg => /\.(test|spec)\./.test(arg))) {
            expect(file).toMatch(/^desktop\/.*\.(test|spec)\.tsx?$/);
            expect(fs.existsSync(path.join(ROOT, file))).toBe(true);
          }
        } else {
          expect(scripts['release:preflight'].split(' && ').filter(command => command === `npm run ${step.packageScript}`)).toHaveLength(1);
        }
      }
    }
  });

  it('requires new backend nightly cases to be wired into release instead of silently omitted', () => {
    const bank = JSON.parse(fs.readFileSync(path.join(ROOT, 'agent-regression-kit/cases/lynn-backend-v1.json'), 'utf8'));
    expect(selectCases(bank, { level: 'nightly' }).map(entry => entry.id)).toEqual(
      selectCases(bank, { level: 'release' }).map(entry => entry.id),
    );
    expect(readPackage().scripts['release:preflight'].split(' && ')).toContain('npm run test:agent-regression');
    expect(readPackage().scripts['release:overnight']).toBe('npm run release:full-gate && npm run test:release:nightly');
  });

  it('isolates nightly sessions and avoids Terminal activation in hidden runs', () => {
    expect(readPackage().scripts['test:release:nightly']).toContain('run-isolated-release-regression.mjs');
    const runner = fs.readFileSync(path.join(ROOT, 'scripts/run-isolated-release-regression.mjs'), 'utf8');
    expect(runner).toContain("fs.mkdtemp(path.join(os.tmpdir(), 'lynn-release-isolated-'))");
    expect(runner).toContain("'--server-info', infoPath");
    expect(runner).toContain('LYNN_HOME: home');
    const terminal = fs.readFileSync(path.join(ROOT, 'scripts/cli-terminal-app-smoke.mjs'), 'utf8');
    expect(terminal).toContain('if (hidden)');
    expect(terminal).toContain('no Terminal.app UI');
  });
  it('routes desktop packaging through the full release gate', () => {
    const scripts = readPackage().scripts;
    expect(scripts.dist).toContain('npm run release:full-gate');
    expect(scripts['dist:win']).toContain('npm run release:full-gate');
    expect(scripts['dist:win']).toContain('npm run prepare:llamacpp:win');
    expect(scripts['dist:win']).toContain('npm run test:windows-llamacpp-installer');
    expect(scripts['dist:win'].indexOf('electron-builder --win nsis --x64')).toBeLessThan(
      scripts['dist:win'].indexOf('npm run test:windows-llamacpp-installer'),
    );
    expect(scripts.dist).not.toContain('npm run release:preflight');
    expect(scripts['dist:win']).not.toContain('npm run release:preflight');
  });

  it('packages the pinned llama.cpp runtime in Windows resources', () => {
    const packageJson = readPackage();
    expect(packageJson.build.win.extraResources).toContainEqual({
      from: 'vendor/llama.cpp/win-x64',
      to: 'llamacpp/bin',
    });
    expect(packageJson.scripts['prepare:llamacpp:win']).toBe(
      'node scripts/prepare-windows-llamacpp.mjs',
    );
    expect(packageJson.scripts['test:windows-llamacpp-installer']).toContain(
      'scripts/verify-windows-llamacpp-installer.ps1',
    );
  });

  it('requires GUI100, CLI200, and live efficiency before release', () => {
    const scripts = readPackage().scripts;
    const fullGate = scripts['release:full-gate'];
    expect(fullGate).toContain('npm run gate:cli-200');
    expect(fullGate).toContain('npm run gate:gui-100');
    expect(fullGate).toContain('npm run release:cli-efficiency');
    expect(fullGate).not.toContain('npm run gate:cli-100');
    expect(scripts['release:preflight']).toContain('npm run test:release:root');
    expect(scripts['test:release:root']).toBe('vitest run --maxWorkers=6');
  });

  it('requires the production Brain to expose a real Codex app-server route', () => {
    const gate = fs.readFileSync(path.join(ROOT, 'scripts', 'mirror-prod-diff.sh'), 'utf8');
    expect(gate).toContain('appServerHarness: true');
    expect(gate).toContain("j.capabilities?.responses === true");
    expect(gate).toContain("j.capabilities?.appServerHarness === true");
    expect(gate).toContain('prod 运行态缺 Responses/app-server harness capabilities');
    expect(gate).toContain("http://127.0.0.1:$PORT/v1/responses");
    expect(gate).toContain("j.error?.type === 'authentication_error'");
    expect(gate).toContain('prod /v1/responses handler 不可用');

    const scripts = readPackage().scripts;
    expect(scripts['release:verify-codex-harness-prod']).toContain('verify-codex-harness-prod.ts');
    expect(scripts['release:preflight']).toContain('npm run release:verify-codex-harness-prod');
  });

  it('compares exported tool names instead of source quote formatting', () => {
    const gate = fs.readFileSync(path.join(ROOT, 'scripts', 'mirror-prod-diff.sh'), 'utf8');
    expect(gate).toContain('SERVER_TOOLS.map(tool => tool.function.name)');
    expect(gate).toContain('[ -n "$local_tools" ]');
    expect(gate).toContain('[ "$local_tools" = "$remote_tools" ]');
  });

  it('builds the CLI before agent regression in a clean checkout', () => {
    const preflight = readPackage().scripts['release:preflight'];
    expect(preflight.indexOf('npm run build:cli')).toBeGreaterThan(-1);
    expect(preflight.indexOf('npm run build:cli')).toBeLessThan(
      preflight.indexOf('npm run test:agent-regression'),
    );
  });
});
