import { execFileSync } from "node:child_process";

// ============================================================================
// 工作区快照 + 回滚(#5)—— 安全探索:动文件前留一个非破坏性快照,验证修不好时能回到干净态。
//
// 安全约束:
//   · 快照用 `git stash create`(只生成 commit 对象,不动工作树/索引/HEAD)→ 零副作用。
//   · 恢复用 `git checkout <ref> -- .`(只把「已跟踪文件」还原到快照)→ 不 `git clean`,
//     绝不删用户的未跟踪文件。最坏情况只是把模型改坏的已跟踪文件还原。
//   · 自动回滚默认关(LYNN_CLI_AUTO_ROLLBACK=1 才开),但恢复命令始终告知用户 → 一键手动撤销。
// ============================================================================

export interface WorkspaceSnapshot {
  available: boolean;
  ref: string | null;
  restoreCommand: string | null;
}

const UNAVAILABLE: WorkspaceSnapshot = { available: false, ref: null, restoreCommand: null };

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 }).trim();
}

function isGitRepo(cwd: string): boolean {
  try {
    return git(cwd, ["rev-parse", "--is-inside-work-tree"]) === "true";
  } catch {
    return false;
  }
}

/** Non-destructive snapshot of the current workspace (tracked changes). Returns unavailable outside git. */
export function createWorkspaceSnapshot(cwd: string): WorkspaceSnapshot {
  if (!isGitRepo(cwd)) return UNAVAILABLE;
  try {
    let ref = "";
    try {
      ref = git(cwd, ["stash", "create", "lynn pre-task snapshot"]);
    } catch {
      ref = "";
    }
    if (!ref) {
      try {
        ref = git(cwd, ["rev-parse", "HEAD"]);
      } catch {
        return UNAVAILABLE; // empty repo with no commits
      }
    }
    return { available: true, ref, restoreCommand: `git checkout ${ref} -- .` };
  } catch {
    return UNAVAILABLE;
  }
}

/** Restore tracked files to the snapshot (DESTRUCTIVE to tracked edits only; never removes untracked files). */
export function restoreWorkspaceSnapshot(cwd: string, snapshot: WorkspaceSnapshot | null): { ok: boolean; message: string } {
  if (!snapshot?.available || !snapshot.ref) return { ok: false, message: "no snapshot available" };
  try {
    git(cwd, ["checkout", snapshot.ref, "--", "."]);
    return { ok: true, message: `restored tracked files to snapshot ${snapshot.ref.slice(0, 12)}` };
  } catch (error) {
    return { ok: false, message: `rollback failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function autoRollbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LYNN_CLI_AUTO_ROLLBACK === "1";
}
