import { describe, expect, it } from 'vitest';
import { agentOptionLabel, buildFleetDispatchPayload } from '../TaskBriefForm';

describe('TaskBriefForm payload', () => {
  it('includes MiMo vision task type and image path for Fleet dispatch', () => {
    const payload = buildFleetDispatchPayload({
      title: 'Ground login button',
      agent: 'mimo-vl',
      taskType: 'ground',
      image: 'screenshots/login.png',
      approval: 'yolo',
      sandbox: 'workspace-write',
      objective: 'Find the login button.',
      owned: 'desktop/src/react/**\n',
      forbidden: 'server/**',
      tests: 'npm run typecheck',
      branch: 'fleet/mimo-ground-login',
      worktree: 'worktrees/fleet-mimo-ground-login',
    });

    expect(payload).toMatchObject({
      agent: 'mimo-vl',
      taskType: 'ground',
      image: 'screenshots/login.png',
      owned: ['desktop/src/react/**'],
      forbidden: ['server/**'],
      testCommands: ['npm run typecheck'],
    });
  });

  it('omits empty image for plain code tasks', () => {
    const payload = buildFleetDispatchPayload({
      title: 'Refactor input',
      agent: 'codex-cli',
      taskType: 'code',
      image: '   ',
      approval: 'ask',
      sandbox: 'read-only',
      objective: 'Split InputArea.',
      owned: 'desktop/src/react/components/input/**',
      forbidden: 'server/**',
      tests: '',
      branch: 'fleet/input',
      worktree: 'worktrees/fleet-input',
    });

    expect(payload).not.toHaveProperty('image');
    expect(payload.taskType).toBe('code');
    expect(payload).toMatchObject({ approval: 'ask', sandbox: 'read-only' });
    expect(payload.testCommands).toEqual([]);
  });

  it('labels unavailable agents with their availability hint', () => {
    expect(agentOptionLabel({ id: 'kimi-cli', label: 'Kimi', enabled: false, availability: 'not found on PATH' })).toBe('Kimi (not found on PATH)');
    expect(agentOptionLabel({ id: 'codex-cli', label: 'Codex', enabled: true, availability: '/bin/codex' })).toBe('Codex');
  });
});
