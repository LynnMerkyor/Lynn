import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAgentStaticPromptCacheKey } from '../core/agent-prompt-cache.js';
import {
  mergeExternalSkillPaths,
  refreshExternalSkillPathExistence,
} from '../core/external-skill-paths.js';

describe('core boundary helpers', () => {
  it('invalidates the static prompt cache for equal-length content changes', () => {
    const base = {
      isZh: true,
      yuanType: 'hanako',
      personality: 'calm',
      skillsText: 'skill-a',
      learnSkillsEnabled: true,
      allowGithubFetch: false,
    };

    expect(createAgentStaticPromptCacheKey(base)).not.toBe(createAgentStaticPromptCacheKey({
      ...base,
      personality: 'warm',
    }));
  });

  it('refreshes discovered paths and reports a newly available directory', () => {
    const refreshed = refreshExternalSkillPathExistence([
      { dirPath: '/skills/ready', label: 'ready', exists: false },
      { dirPath: '/skills/missing', label: 'missing', exists: false },
    ], (filePath) => filePath.endsWith('/ready'));

    expect(refreshed.newDirectoryAppeared).toBe(true);
    expect(refreshed.paths).toEqual([
      { dirPath: '/skills/ready', label: 'ready', exists: true },
      { dirPath: '/skills/missing', label: 'missing', exists: false },
    ]);
  });

  it('merges configured skill paths without duplicates or missing discoveries', () => {
    const configured = path.resolve('/skills/ready');
    expect(mergeExternalSkillPaths([
      { dirPath: configured, label: 'ready', exists: true },
      { dirPath: '/skills/missing', label: 'missing', exists: false },
    ], [configured, '/custom/team/skills'])).toEqual([
      { dirPath: configured, label: 'ready' },
      { dirPath: path.resolve('/custom/team/skills'), label: 'team' },
    ]);
  });
});
