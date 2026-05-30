import { getStringFlag, hasFlag, type ParsedArgs } from "../args.js";
import { listProviderPresets } from "../provider-presets.js";
import { providerProfilePath, readCliProviderProfile, redactApiKey } from "../provider-profile.js";
import { resolveDataDir } from "../session/store.js";
import { readVersionInfo } from "../version.js";
import { brainRouteReadiness, fetchBrainProviderStatus, type BrainProviderStatus } from "../brain-status.js";

export interface DoctorResult {
  ok: boolean;
  version: string;
  node: string;
  brainUrl: string;
  brain: "ok" | "skipped" | "unreachable";
  brainProviders?: BrainProviderStatus | null;
  cliProvider: {
    configured: boolean;
    path: string;
    provider?: string;
    baseUrl?: string;
    model?: string;
    apiKey?: string;
  };
  presets: string[];
  checks: Array<{ name: string; ok: boolean; message: string }>;
}

export async function runDoctor(args: ParsedArgs): Promise<DoctorResult> {
  const version = readVersionInfo();
  const brainUrl = getStringFlag(args.flags, "brain-url") || process.env.LYNN_BRAIN_URL || "http://127.0.0.1:8790";
  const dataDir = resolveDataDir(getStringFlag(args.flags, "data-dir"));
  const profile = await readCliProviderProfile(dataDir);
  const profilePath = providerProfilePath(dataDir);
  const presets = listProviderPresets().map((preset) => `${preset.name}:${preset.model}`);
  const checks: DoctorResult["checks"] = [
    { name: "node", ok: true, message: process.version },
    { name: "cwd", ok: true, message: process.cwd() },
    profile
      ? { name: "cli-byok", ok: true, message: `${profile.provider} / ${profile.model} @ ${profile.baseUrl} (key ${redactApiKey(profile.apiKey)})` }
      : { name: "cli-byok", ok: true, message: `not configured (${profilePath}); optional CLI-only BYOK: Lynn providers set --preset stepfun --api-key <api-key>` },
    { name: "presets", ok: true, message: presets.join(", ") },
  ];

  let brain: DoctorResult["brain"] = "skipped";
  let brainProviders: BrainProviderStatus | null = null;
  if (!hasFlag(args.flags, "offline")) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    try {
      const res = await fetch(new URL("/health", brainUrl), { signal: ctrl.signal });
      brain = res.ok ? "ok" : "unreachable";
      checks.push({ name: "brain", ok: res.ok, message: `${res.status} ${res.statusText}`.trim() });
      if (res.ok) {
        const providerStatus = await fetchBrainProviderStatus(brainUrl, 1500);
        brainProviders = providerStatus;
        const readiness = brainRouteReadiness(providerStatus);
        checks.push({
          name: "brain-route",
          ok: readiness.usable,
          message: readiness.message,
        });
      }
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
    brainProviders,
    cliProvider: {
      configured: !!profile,
      path: profilePath,
      provider: profile?.provider,
      baseUrl: profile?.baseUrl,
      model: profile?.model,
      apiKey: profile ? redactApiKey(profile.apiKey) : undefined,
    },
    presets,
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
