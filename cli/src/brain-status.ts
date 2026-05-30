export interface BrainProviderStatusEntry {
  id: string;
  model: string;
  endpoint: string;
  wire: string;
  credential: "set" | "missing" | "not_required";
  configured: boolean;
  local: boolean;
  inRoute: boolean;
}

export interface BrainProviderStatus {
  ok: true;
  route: string[];
  providers: BrainProviderStatusEntry[];
}

export async function fetchBrainProviderStatus(brainUrl: string, timeoutMs = 1500): Promise<BrainProviderStatus | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(new URL("/v1/providers/status", brainUrl), { signal: ctrl.signal });
    if (!res.ok) return null;
    const parsed = await res.json() as Partial<BrainProviderStatus>;
    if (parsed?.ok !== true || !Array.isArray(parsed.route) || !Array.isArray(parsed.providers)) return null;
    return parsed as BrainProviderStatus;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function summarizeBrainProviderStatus(status: BrainProviderStatus | null): string {
  if (!status) return "provider status unavailable";
  const byId = new Map(status.providers.map((provider) => [provider.id, provider]));
  const route = status.route.slice(0, 6).map((id) => {
    const provider = byId.get(id);
    if (!provider) return `${id}:unknown`;
    if (provider.credential === "set") return `${id}:key`;
    if (provider.credential === "not_required") return `${id}:local`;
    return `${id}:missing-key`;
  });
  return route.join(" -> ");
}

export function brainRouteHeadReady(status: BrainProviderStatus | null): boolean {
  if (!status || !status.route.length) return false;
  const head = status.providers.find((provider) => provider.id === status.route[0]);
  return Boolean(head?.configured);
}
