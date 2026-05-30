import { describe, expect, it } from 'vitest';
import { DEFAULT_FLEET_SCOPE_PRESET, FLEET_SCOPE_PRESETS, buildPresetDefaults, slugifyBriefTitle } from '../brief-presets';

describe('fleet brief presets', () => {
  it('slugifies titles for branch and worktree names', () => {
    expect(slugifyBriefTitle('Split InputArea.tsx safely')).toBe('split-inputarea-tsx-safely');
    expect(slugifyBriefTitle('  ')).toBe('task');
  });

  it('builds branch, worktree, scope, and test defaults', () => {
    const defaults = buildPresetDefaults(DEFAULT_FLEET_SCOPE_PRESET, 'Add chat mode');
    expect(defaults.branch).toBe('fleet/cli-add-chat-mode');
    expect(defaults.worktree).toBe('worktrees/fleet-cli-add-chat-mode');
    expect(defaults.owned).toContain('cli/**');
    expect(defaults.forbidden).toContain('server/**');
    expect(defaults.tests).toContain('npm --prefix cli test');
  });

  it('keeps every preset guarded by owned and forbidden scopes', () => {
    expect(FLEET_SCOPE_PRESETS.length).toBeGreaterThan(3);
    for (const preset of FLEET_SCOPE_PRESETS) {
      expect(preset.owned.length).toBeGreaterThan(0);
      expect(preset.forbidden.length).toBeGreaterThan(0);
      expect(preset.tests.length).toBeGreaterThan(0);
    }
  });
});
