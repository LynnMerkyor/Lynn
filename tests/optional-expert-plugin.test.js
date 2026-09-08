import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { ExpertManager } from '../core/expert-manager.js';
import { PluginManager } from '../core/plugin-manager.js';

const homes = [];
afterEach(() => { for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true }); });

describe('optional expert roundtable plugin', () => {
  it('installs into an explicit home, loads six presets, and unloads without changing existing data', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lynn-optional-expert-'));
    homes.push(home);
    fs.mkdirSync(path.join(home, 'agents', 'existing'), { recursive: true });
    const history = path.join(home, 'agents', 'existing', 'history.jsonl');
    fs.writeFileSync(history, 'existing conversation\n');
    const expertManager = new ExpertManager({
      getAgentManager: () => ({}), getModelManager: () => ({}), getSkillManager: () => ({}),
    });
    expect(expertManager.listExperts()).toEqual([]);
    execFileSync(process.execPath, ['optional-plugins/expert-roundtable/install.mjs', '--home', home]);
    expect(() => execFileSync(process.execPath, ['optional-plugins/expert-roundtable/install.mjs', '--home', home], { stdio: 'pipe' })).toThrow();
    const manager = new PluginManager({
      pluginsDir: path.join(home, 'plugins'), dataDir: path.join(home, 'plugin-data'),
      engine: { registerExpertPresets: (id, dir) => expertManager.registerPresets(id, dir) },
    });
    manager.scan();
    await manager.loadAll();
    expect(expertManager.listExperts()).toHaveLength(6);
    expect(expertManager.getExpert('financial-analyst').identity).toBeTruthy();
    await manager.unloadPlugin('expert-roundtable');
    expect(expertManager.listExperts()).toEqual([]);
    expect(fs.readFileSync(history, 'utf8')).toBe('existing conversation\n');
  });
});
