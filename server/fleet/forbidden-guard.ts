/**
 * forbidden-guard.ts — the anti-cheat scope check (B-line).
 *
 * Takes the ACTUAL changed paths (from `git diff`, never the worker's self-report)
 * and intersects them with the brief's forbidden globs + center-lock list. A buggy
 * or dishonest worker cannot hide an out-of-scope edit because the verdict is
 * derived from git, not from what the worker claims it changed.
 */
import type { FleetChangedFile } from "../../shared/fleet-events.js";

const REGEX_SPECIALS = "\\^$.|?+()[]{}";

/** Convert a gitignore-ish glob (supports `**` across segments and `*` within one) to a RegExp. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") i++; // consume the slash in `**/`
        re += "[^]*"; // any chars including `/`
      } else {
        re += "[^/]*"; // any chars except `/`
      }
    } else if (REGEX_SPECIALS.includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

export function matchAnyGlob(path: string, globs: string[]): boolean {
  return globs.some((g) => g === path || globToRegExp(g).test(path));
}

export interface ScopeVerdict {
  forbiddenPaths: string[];
  centerLockPaths: string[];
  ok: boolean;
}

export function evaluateScope(
  changedPaths: string[],
  forbiddenGlobs: string[],
  centerLocks: string[] = [],
): ScopeVerdict {
  const forbiddenPaths = changedPaths.filter((p) => matchAnyGlob(p, forbiddenGlobs));
  const centerLockPaths = changedPaths.filter((p) => matchAnyGlob(p, centerLocks));
  return {
    forbiddenPaths,
    centerLockPaths,
    ok: forbiddenPaths.length === 0 && centerLockPaths.length === 0,
  };
}

/** Annotate changed files with forbidden / centerLocked flags for the GUI red flag. */
export function annotateChangedFiles(
  files: FleetChangedFile[],
  forbiddenGlobs: string[],
  centerLocks: string[] = [],
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
