import { getStringFlag, hasFlag, type ParsedArgs } from "../args.js";
import { readVersionInfo } from "../version.js";

export interface DoctorResult {
  ok: boolean;
  version: string;
  node: string;
  brainUrl: string;
  brain: "ok" | "skipped" | "unreachable";
  checks: Array<{ name: string; ok: boolean; message: string }>;
}

export async function runDoctor(args: ParsedArgs): Promise<DoctorResult> {
  const version = readVersionInfo();
  const brainUrl = getStringFlag(args.flags, "brain-url") || process.env.LYNN_BRAIN_URL || "http://127.0.0.1:8790";
  const checks: DoctorResult["checks"] = [
    { name: "node", ok: true, message: process.version },
    { name: "cwd", ok: true, message: process.cwd() },
  ];

  let brain: DoctorResult["brain"] = "skipped";
  if (!hasFlag(args.flags, "offline")) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    try {
      const res = await fetch(new URL("/health", brainUrl), { signal: ctrl.signal });
      brain = res.ok ? "ok" : "unreachable";
      checks.push({ name: "brain", ok: res.ok, message: `${res.status} ${res.statusText}`.trim() });
    } catch (error) {
      brain = "unreachable";
      const message = error instanceof Error ? error.message : String(error);
      checks.push({ name: "brain", ok: false, message });
    } finally {
      clearTimeout(timer);
    }
  } else {
    checks.push({ name: "brain", ok: true, message: "skipped (--offline)" });
  }

  return {
    ok: checks.every((check) => check.ok),
    version: version.version,
    node: process.version,
    brainUrl,
    brain,
    checks,
  };
}

export function renderDoctor(result: DoctorResult): string {
  const lines = [
    `Lynn CLI ${result.version}`,
    `Node ${result.node}`,
    `Brain ${result.brain}: ${result.brainUrl}`,
    "",
    ...result.checks.map((check) => `${check.ok ? "OK" : "FAIL"} ${check.name}: ${check.message}`),
  ];
  return lines.join("\n");
}
