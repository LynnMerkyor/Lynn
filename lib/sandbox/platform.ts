/**
 * platform.js — 平台检测 + 沙盒工具可用性
 */

import { execFileSync } from "child_process";

export type SandboxPlatform = "seatbelt" | "bwrap" | "win32-full-access" | "unsupported";

export function detectPlatform(): SandboxPlatform {
  if (process.platform === "darwin") return "seatbelt";
  if (process.platform === "linux") return "bwrap";
  if (process.platform === "win32") return "win32-full-access";
  return "unsupported";
}

export function checkAvailability(platform: SandboxPlatform): boolean {
  try {
    if (platform === "seatbelt") {
      execFileSync("which", ["sandbox-exec"], { stdio: "ignore", windowsHide: true });
      return true;
    }
    if (platform === "bwrap") {
      execFileSync("which", ["bwrap"], { stdio: "ignore", windowsHide: true });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}
