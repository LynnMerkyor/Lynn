import type { FleetWorkerView } from './fleet-reducer';

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
}

export function resolveWorkerWorktreePath(worker: Pick<FleetWorkerView, 'cwd' | 'worktree'>): string | null {
  const worktree = worker.worktree?.trim();
  if (!worktree) return null;
  if (isAbsolutePath(worktree)) return worktree;
  const cwd = worker.cwd?.trim();
  if (!cwd) return worktree;
  return `${cwd.replace(/[\\/]+$/, '')}/${worktree.replace(/^[\\/]+/, '')}`;
}
