import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const options = { timeout: 2_000, maxBuffer: 512 * 1024, windowsHide: true, encoding: "utf8" as const };

function windowsBinary(...parts: string[]): string {
  const root = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  return path.win32.join(path.win32.isAbsolute(root) ? root : "C:\\Windows", "System32", ...parts);
}

export async function localListenerPids(port: string, platform: NodeJS.Platform = process.platform): Promise<number[]> {
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) return [];
  try {
    if (platform === "win32") {
      const { stdout } = await execute(windowsBinary("netstat.exe"), ["-ano", "-p", "tcp"], options);
      return [...new Set(stdout.split(/\r?\n/).flatMap(line => {
        const fields = line.trim().split(/\s+/);
        const pid = Number(fields[4]);
        return fields[0] === "TCP" && fields[1]?.endsWith(`:${Number(port)}`)
          && fields[3] === "LISTENING" && Number.isSafeInteger(pid) && pid > 0 ? [pid] : [];
      }))];
    }
    const { stdout } = await execute("lsof", ["-nP", `-iTCP:${Number(port)}`, "-sTCP:LISTEN", "-t"], options);
    return [...new Set(stdout.split(/\s+/).map(Number).filter(pid => Number.isSafeInteger(pid) && pid > 0))];
  } catch {
    return [];
  }
}

export async function localLlamaProcesses(platform: NodeJS.Platform = process.platform): Promise<Array<{ pid: number; command: string }>> {
  try {
    if (platform === "win32") {
      const script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process -Filter \"Name = 'llama-server.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
      const { stdout } = await execute(windowsBinary("WindowsPowerShell", "v1.0", "powershell.exe"),
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script], options);
      if (!stdout.trim()) return [];
      const parsed: unknown = JSON.parse(stdout.replace(/^\uFEFF/, ""));
      return (Array.isArray(parsed) ? parsed : [parsed]).flatMap(row => {
        const pid = row?.ProcessId;
        return Number.isSafeInteger(pid) && pid > 0 && typeof row?.CommandLine === "string"
          ? [{ pid, command: row.CommandLine }] : [];
      });
    }
    const { stdout } = await execute("ps", ["-axo", "pid=,command="], options);
    return stdout.split(/\r?\n/).flatMap(line => {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      const pid = Number(match?.[1]);
      return match && Number.isSafeInteger(pid) && pid > 0 && /llama-server\b/.test(match[2])
        ? [{ pid, command: match[2] }] : [];
    });
  } catch {
    return [];
  }
}
