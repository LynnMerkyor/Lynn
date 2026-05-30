import type { FleetChangedFile } from "./fleet-events.js";

const REGEX_SPECIALS = "\\^$.|?+()[]{}";

/** Convert a gitignore-ish glob (supports `**` across segments and `*` within one) to a RegExp. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i += 1;
        if (glob[i + 1] === "/") i += 1;
        re += "[^]*";
      } else {
        re += "[^/]*";
      }
    } else if (REGEX_SPECIALS.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchAnyGlob(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => g === path || globToRegExp(g).test(path));
}

export interface ScopeVerdict {
  forbiddenPaths: string[];
  centerLockPaths: string[];
  ok: boolean;
}

export function evaluateScope(
  changedPaths: readonly string[],
  forbiddenGlobs: readonly string[],
  centerLocks: readonly string[] = [],
): ScopeVerdict {
  const forbiddenPaths = changedPaths.filter((p) => matchAnyGlob(p, forbiddenGlobs));
  const centerLockPaths = changedPaths.filter((p) => matchAnyGlob(p, centerLocks));
  return {
    forbiddenPaths,
    centerLockPaths,
    ok: forbiddenPaths.length === 0 && centerLockPaths.length === 0,
  };
}

export function annotateChangedFiles(
  files: readonly FleetChangedFile[],
  forbiddenGlobs: readonly string[],
  centerLocks: readonly string[] = [],
): FleetChangedFile[] {
  return files.map((f) => {
    const forbidden = matchAnyGlob(f.path, forbiddenGlobs);
    const centerLocked = matchAnyGlob(f.path, centerLocks);
    return {
      ...f,
      ...(forbidden ? { forbidden: true } : {}),
      ...(centerLocked ? { centerLocked: true } : {}),
    };
  });
}
