import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');

function readPackage() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
}

describe('release gate contract', () => {
  it('routes desktop packaging through the full release gate', () => {
    const scripts = readPackage().scripts;
    expect(scripts.dist).toContain('npm run release:full-gate');
    expect(scripts['dist:win']).toContain('npm run release:full-gate');
    expect(scripts['dist:win']).toContain('npm run prepare:llamacpp:win');
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
  });

  it('keeps the release gate aligned with the approved GUI100 and CLI100 policy', () => {
    const fullGate = readPackage().scripts['release:full-gate'];
    expect(fullGate).toContain('npm run gate:cli-100');
    expect(fullGate).toContain('npm run gate:gui-100');
    expect(fullGate).not.toContain('npm run gate:cli-200');
  });

  it('requires the production Brain to declare Codex app-server capabilities', () => {
    const gate = fs.readFileSync(path.join(ROOT, 'scripts', 'mirror-prod-diff.sh'), 'utf8');
    expect(gate).toContain('appServerHarness: true');
    expect(gate).toContain("j.capabilities?.responses === true");
    expect(gate).toContain("j.capabilities?.appServerHarness === true");
    expect(gate).toContain('prod 运行态缺 Responses/app-server harness capabilities');
  });
});
