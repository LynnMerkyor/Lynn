import { describe, expect, it } from 'vitest';
import { buildFleetDispatchPayload } from '../TaskBriefForm';

describe('TaskBriefForm payload', () => {
  it('includes MiMo vision task type and image path for Fleet dispatch', () => {
    const payload = buildFleetDispatchPayload({
      title: 'Ground login button',
      agent: 'mimo-vl',
      taskType: 'ground',
      image: 'screenshots/login.png',
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
      objective: 'Split InputArea.',
      owned: 'desktop/src/react/components/input/**',
      forbidden: 'server/**',
      tests: '',
      branch: 'fleet/input',
      worktree: 'worktrees/fleet-input',
    });

    expect(payload).not.toHaveProperty('image');
    expect(payload.taskType).toBe('code');
    expect(payload.testCommands).toEqual([]);
  });
});

