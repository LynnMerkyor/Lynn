export interface FleetScopePreset {
  id: string;
  label: string;
  description: string;
  owned: string[];
  forbidden: string[];
  tests: string[];
  branchPrefix: string;
  worktreePrefix: string;
}

export interface FleetBriefDefaults {
  owned: string;
  forbidden: string;
  tests: string;
  branch: string;
  worktree: string;
}

export const FLEET_SCOPE_PRESETS: FleetScopePreset[] = [
  {
    id: 'cli-core',
    label: 'CLI core',
    description: 'Lynn CLI commands, worker adapters, JSONL behaviour.',
    owned: ['cli/**'],
    forbidden: ['desktop/src/react/**', 'server/**', 'brain-v2-mirror/**'],
    tests: ['npm --prefix cli test', 'npm --prefix cli run typecheck'],
    branchPrefix: 'fleet/cli',
    worktreePrefix: 'worktrees/fleet-cli',
  },
  {
    id: 'gui-fleet',
    label: 'GUI Fleet',
    description: 'Workers panel, fleet store, server Fleet route, dispatch UX.',
    owned: ['desktop/src/react/components/fleet/**', 'desktop/src/react/stores/fleet-slice.ts', 'server/routes/fleet.ts', 'server/fleet/**'],
    forbidden: ['cli/**', 'shared/fleet-events.ts', 'server/routes/chat.ts', 'core/engine.ts'],
    tests: [
      'npm run typecheck',
      'npx vitest run desktop/src/react/components/fleet/__tests__ server/fleet/__tests__/fleet-server.test.ts --reporter=dot',
    ],
    branchPrefix: 'fleet/gui',
    worktreePrefix: 'worktrees/fleet-gui',
  },
  {
    id: 'desktop-ui',
    label: 'Desktop UI',
    description: 'Renderer components and UX polish outside the Fleet protocol.',
    owned: ['desktop/src/react/**'],
    forbidden: ['cli/**', 'server/routes/chat.ts', 'core/engine.ts', 'brain-v2-mirror/**'],
    tests: ['npm run typecheck', 'npm run build:renderer'],
    branchPrefix: 'fleet/ui',
    worktreePrefix: 'worktrees/fleet-ui',
  },
  {
    id: 'server-safe',
    label: 'Server safe refactor',
    description: 'Small server modules only; center files remain locked.',
    owned: ['server/**'],
    forbidden: ['server/routes/chat.ts', 'core/engine.ts', 'desktop/src/react/**', 'cli/**'],
    tests: ['npm run typecheck', 'npm run typecheck:runtime'],
    branchPrefix: 'fleet/server',
    worktreePrefix: 'worktrees/fleet-server',
  },
  {
    id: 'docs-plan',
    label: 'Docs / planning',
    description: 'README, release notes, ops docs, planning briefs.',
    owned: ['README.md', 'README_EN.md', 'docs/**'],
    forbidden: ['server/**', 'core/**', 'desktop/src/react/**', 'cli/**', 'brain-v2-mirror/**'],
    tests: ['git diff --check'],
    branchPrefix: 'fleet/docs',
    worktreePrefix: 'worktrees/fleet-docs',
  },
];

export const DEFAULT_FLEET_SCOPE_PRESET = FLEET_SCOPE_PRESETS[0]!;

export function slugifyBriefTitle(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'task';
}

export function buildPresetDefaults(preset: FleetScopePreset, title: string): FleetBriefDefaults {
  const slug = slugifyBriefTitle(title);
  return {
    owned: preset.owned.join('\n'),
    forbidden: preset.forbidden.join('\n'),
    tests: preset.tests.join('\n'),
    branch: `${preset.branchPrefix}-${slug}`,
    worktree: `${preset.worktreePrefix}-${slug}`,
  };
}
