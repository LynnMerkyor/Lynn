/**
 * os-sandbox.ts — optional kernel-enforced write confinement for shell tools.
 *
 * The regex allow/deny list in bash.ts is a speed bump, not a boundary: any
 * interpreter (`node -e`, `python -c`) can write anywhere the user can. When
 * LYNN_CLI_OS_SANDBOX=1 is set on macOS, commands run under seatbelt with writes
 * limited to the workspace, temp directories, Lynn's own data dir and a small
 * set of package-manager caches. Everything else keeps working normally.
 *
 * This is opt-in because it is platform-specific (macOS only for now) and a
 * confined build can legitimately need a cache directory outside the list.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolRunContext } from "./tools/types.js";

export interface SandboxedCommand {
  file: string;
  args: string[];
}

export function osSandboxEnabled(): boolean {
  const value = (process.env.LYNN_CLI_OS_SANDBOX || "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "seatbelt";
}

export function wrapBashCommand(
  command: string,
  ctx: Pick<ToolRunContext, "cwd" | "sandbox">,
): SandboxedCommand | null {
  if (!osSandboxEnabled()) return null;
  if (process.platform !== "darwin") return null;
  if (ctx.sandbox === "danger-full-access") return null;
  const profile = seatbeltProfile(ctx);
  return { file: "/usr/bin/sandbox-exec", args: ["-p", profile, "/bin/sh", "-c", command] };
}

export function seatbeltProfile(ctx: Pick<ToolRunContext, "cwd" | "sandbox">): string {
  if (ctx.sandbox === "read-only") {
    return "(version 1)(allow default)(deny file-write*)";
  }
  const writable = new Set<string>();
  const add = (candidate: string | undefined): void => {
    if (!candidate) return;
    try {
      writable.add(fs.realpathSync(candidate));
    } catch {
      writable.add(path.resolve(candidate));
    }
  };
  add(ctx.cwd);
  add(os.tmpdir());
  add("/tmp");
  add("/private/tmp");
  add("/dev");
  add(path.join(os.homedir(), ".lynn"));
  add(path.join(os.homedir(), ".npm"));
  add(path.join(os.homedir(), ".cache"));
  add(path.join(os.homedir(), "Library", "Caches"));
  for (const extra of (process.env.LYNN_CLI_SANDBOX_WRITABLE || "").split(path.delimiter)) {
    add(extra.trim());
  }
  const allow = [...writable].map((entry) => `(subpath ${JSON.stringify(entry)})`).join(" ");
  return `(version 1)(allow default)(deny file-write*) (allow file-write* ${allow})`;
}
