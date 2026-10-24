import { execFile, type ChildProcess } from "node:child_process";
import path from "node:path";

export function stopProcessTree(child: ChildProcess): boolean {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return false;
  if (process.platform === "win32") {
    const configuredRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
    const root = path.win32.isAbsolute(configuredRoot) ? configuredRoot : "C:\\Windows";
    execFile(path.win32.join(root, "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      timeout: 5000,
    }, error => {
      if (error && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });
    return true;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
    return true;
  } catch {
    return child.kill("SIGKILL");
  }
}
