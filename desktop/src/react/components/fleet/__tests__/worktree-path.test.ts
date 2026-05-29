import { describe, expect, it } from 'vitest';
import { resolveWorkerWorktreePath } from '../worktree-path';

describe('resolveWorkerWorktreePath', () => {
  it('keeps absolute worktree paths unchanged', () => {
    expect(resolveWorkerWorktreePath({
      cwd: '/Users/lynn',
      worktree: '/private/tmp/lynn-v080-cli-core',
    })).toBe('/private/tmp/lynn-v080-cli-core');
  });

  it('resolves relative worktree paths against cwd', () => {
    expect(resolveWorkerWorktreePath({
      cwd: '/Users/lynn/Downloads/Lynn/',
      worktree: 'worktrees/worker-a',
    })).toBe('/Users/lynn/Downloads/Lynn/worktrees/worker-a');
  });

  it('returns null when no worktree is available', () => {
    expect(resolveWorkerWorktreePath({ cwd: '/tmp' })).toBeNull();
  });
});
