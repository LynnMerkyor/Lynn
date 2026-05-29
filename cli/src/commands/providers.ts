import { type ParsedArgs, getStringFlag, hasFlag } from "../args.js";
import { nowIso, writeJsonLine } from "../jsonl.js";
import { fetchLocalServerJson, readLocalServerInfo, type LocalServerLookup } from "../local-server.js";

export interface ProvidersInfo {
  defaultRoute: string;
  byokEntry: string;
  keyPolicy: string;
  brainUrl: string;
  server: {
    status: LocalServerLookup["status"] | "disabled";
    url?: string;
    version?: string;
    message?: string;
  };
  activeProvider?: string;
  activeModel?: string;
  providers: ProviderLine[];
}

export interface ProviderLine {
  id: string;
  displayName: string;
  type: string;
  configured: boolean;
  modelCount: number;
  oauth?: boolean;
  codingPlan?: boolean;
}

export function providersInfo(partial: Partial<ProvidersInfo> = {}): ProvidersInfo {
  return {
    defaultRoute: "MiMo via local Brain router (auto)",
    byokEntry: "Open Lynn GUI > Settings > Providers",
    keyPolicy: "Provider keys stay in Lynn settings/server storage; the CLI does not print or store them.",
    brainUrl: process.env.LYNN_BRAIN_URL || "http://127.0.0.1:8790",
    server: { status: "missing", message: "Lynn GUI server-info.json not found" },
    providers: [],
    ...partial,
  };
}

export function renderProvidersInfo(info: ProvidersInfo): string {
  const active = activeRouteLabel(info);
  const serverLine = info.server.url
    ? `${info.server.status} · ${info.server.url}${info.server.version ? ` · v${info.server.version}` : ""}`
    : `${info.server.status}${info.server.message ? ` · ${info.server.message}` : ""}`;
  const configured = info.providers.filter((p) => p.configured);
  return [
    "Lynn Providers / BYOK",
    "",
    `Current route: ${active}`,
    `Default route: ${info.defaultRoute}`,
    `Brain URL:      ${info.brainUrl}`,
    `Local server:   ${serverLine}`,
    `BYOK entry:     ${info.byokEntry}`,
    configured.length > 0
      ? `Configured:    ${configured.slice(0, 6).map((p) => `${p.displayName}${p.modelCount ? ` (${p.modelCount})` : ""}`).join(", ")}${configured.length > 6 ? ` +${configured.length - 6}` : ""}`
      : "Configured:    none detected yet",
    "",
    info.keyPolicy,
    "",
    "After you add a provider in the GUI, Lynn CLI will use it through the same local Brain/router path.",
    "Use Lynn model or /model in chat to review this route. Use --brain-url to point at another local endpoint.",
  ].join("\n");
}

export function activeRouteLabel(info: Pick<ProvidersInfo, "activeProvider" | "activeModel" | "defaultRoute">): string {
  return [info.activeProvider, info.activeModel].filter(Boolean).join(" / ") || info.defaultRoute;
}

export async function resolveProvidersInfo(args: ParsedArgs, timeoutMs = 1500): Promise<ProvidersInfo> {
  const brainUrl = getStringFlag(args.flags, "brain-url") || process.env.LYNN_BRAIN_URL || "http://127.0.0.1:8790";
  const dataDir = getStringFlag(args.flags, "data-dir");
  const serverUrl = getStringFlag(args.flags, "server-url") || process.env.LYNN_SERVER_URL || "";
  let lookup: LocalServerLookup = serverUrl
    ? { status: "ok", url: serverUrl }
    : await readLocalServerInfo(dataDir);
  if (lookup.url && !/^https?:\/\//i.test(lookup.url)) {
    lookup = { ...lookup, url: `http://${lookup.url}` };
  }
  const base = providersInfo({
    brainUrl,
    server: {
      status: lookup.status,
      url: lookup.url,
      version: lookup.version,
      message: lookup.message,
    },
  });

  if (lookup.status !== "ok") return base;

  try {
    const [summary, config] = await Promise.all([
      fetchLocalServerJson<ProviderSummaryResponse>(lookup, "/api/providers/summary", timeoutMs),
      fetchLocalServerJson<Record<string, unknown>>(lookup, "/api/config", timeoutMs).catch(() => null),
    ]);
    return {
      ...base,
      activeProvider: readActiveProvider(config),
      activeModel: readActiveModel(config),
      providers: sanitizeProviderSummary(summary),
    };
  } catch (error) {
    return {
      ...base,
      server: {
        ...base.server,
        status: "unreachable",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export async function runProviders(args: ParsedArgs, json = hasFlag(args.flags, "json", "jsonl")): Promise<number> {
  const info = await resolveProvidersInfo(args);
  if (json) {
    writeJsonLine({ type: "providers.info", ts: nowIso(), ...info });
  } else {
    process.stdout.write(`${renderProvidersInfo(info)}\n`);
  }
  return 0;
}

interface ProviderSummaryResponse {
  providers?: Record<string, {
    display_name?: string;
    type?: string;
    has_credentials?: boolean;
    logged_in?: boolean;
    supports_oauth?: boolean;
    is_coding_plan?: boolean;
    models?: unknown[];
    custom_models?: unknown[];
  }>;
}

function sanitizeProviderSummary(response: ProviderSummaryResponse): ProviderLine[] {
  return Object.entries(response.providers || {})
    .map(([id, provider]) => {
      const modelCount = (Array.isArray(provider.models) ? provider.models.length : 0)
        + (Array.isArray(provider.custom_models) ? provider.custom_models.length : 0);
      return {
        id,
        displayName: String(provider.display_name || id),
        type: String(provider.type || "api-key"),
        configured: !!(provider.has_credentials || provider.logged_in),
        modelCount,
        oauth: !!provider.supports_oauth,
        codingPlan: !!provider.is_coding_plan,
      };
    })
    .sort((a, b) => Number(b.configured) - Number(a.configured) || a.displayName.localeCompare(b.displayName));
}

function readActiveProvider(config: Record<string, unknown> | null): string | undefined {
  const raw = readRecord(readRecord(config, "_raw"), "api");
  const rawProvider = stringValue(raw?.provider);
  if (rawProvider) return rawProvider;
  return stringValue(readRecord(config, "api")?.provider);
}

function readActiveModel(config: Record<string, unknown> | null): string | undefined {
  const chat = readRecord(config, "models")?.chat;
  if (typeof chat === "string") return chat;
  if (chat && typeof chat === "object" && !Array.isArray(chat)) {
    return stringValue((chat as Record<string, unknown>).id);
  }
  return undefined;
}

function readRecord(record: Record<string, unknown> | null | undefined, key: string): Record<string, unknown> | null {
  const value = record?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
