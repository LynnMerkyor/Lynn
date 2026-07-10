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
    expect(scripts.dist).not.toContain('npm run release:preflight');
    expect(scripts['dist:win']).not.toContain('npm run release:preflight');
  });

  it('keeps the release gate aligned with the approved GUI100 and CLI100 policy', () => {
    const fullGate = readPackage().scripts['release:full-gate'];
    expect(fullGate).toContain('npm run gate:cli-100');
    expect(fullGate).toContain('npm run gate:gui-100');
    expect(fullGate).not.toContain('npm run gate:cli-200');
  });
});
