export interface ProviderFallbackHop {
  id: string;
  reason?: string;
}

export interface ProviderRouteMeta {
  activeProvider: string;
  fallbackFrom?: ProviderFallbackHop[];
}

interface RawProviderFallbackHop {
  id?: unknown;
  provider?: unknown;
  providerId?: unknown;
  name?: unknown;
  reason?: unknown;
  status?: unknown;
  error?: unknown;
}

interface ProviderRouteEvent {
  [key: string]: unknown;
  assistantMessageEvent?: ProviderRouteEvent | null;
}

export function normalizeProviderFallbackHop(raw: RawProviderFallbackHop | null | undefined): ProviderFallbackHop | null {
  const id = String(raw?.id || raw?.provider || raw?.providerId || raw?.name || "").trim();
  if (!id) return null;
  const reason = String(raw?.reason || raw?.status || raw?.error || "").trim().slice(0, 160);
  return reason ? { id, reason } : { id };
}

/**
 * Extracts the normalized provider routing metadata from SSE or websocket
 * event envelopes.
 */
export function extractProviderRouteMeta(event: ProviderRouteEvent | null | undefined): ProviderRouteMeta | null {
  if (!event || typeof event !== "object") return null;
  const assistantEvent = event.assistantMessageEvent && typeof event.assistantMessageEvent === "object"
    ? event.assistantMessageEvent
    : null;
  const metaCandidate = event.meta
    || event.providerMeta
    || event.provider_route
    || event.providerRoute
    || assistantEvent?.meta
    || assistantEvent?.providerMeta
    || assistantEvent?.provider_route
    || assistantEvent?.providerRoute
    || null;
  const markedProviderEvent = event.object === "lynn.provider"
    || event.type === "provider_meta"
    || event.type === "provider_update"
    || event.type === "lynn.provider"
    || assistantEvent?.object === "lynn.provider"
    || assistantEvent?.type === "provider_meta"
    || assistantEvent?.type === "provider_update";
  const source = metaCandidate && typeof metaCandidate === "object"
    ? metaCandidate
    : (markedProviderEvent ? event : null);
  if (!source || typeof source !== "object") return null;
  const activeProvider = String(
    (source as Record<string, unknown>).activeProvider
    || (source as Record<string, unknown>).active_provider
    || (source as Record<string, unknown>).providerId
    || (source as Record<string, unknown>).provider
    || event.activeProvider
    || event.active_provider
    || "",
  ).trim();
  if (!activeProvider) return null;
  const rawFallback = Array.isArray((source as Record<string, unknown>).fallbackFrom)
    ? (source as Record<string, unknown>).fallbackFrom
    : (Array.isArray((source as Record<string, unknown>).fallback_from)
      ? (source as Record<string, unknown>).fallback_from
      : (Array.isArray(event.fallbackFrom) ? event.fallbackFrom : event.fallback_from));
  const fallbackFrom: ProviderFallbackHop[] = Array.isArray(rawFallback)
    ? (rawFallback as RawProviderFallbackHop[]).map(normalizeProviderFallbackHop).filter((hop): hop is ProviderFallbackHop => hop !== null).slice(0, 8)
    : [];
  return {
    activeProvider,
    ...(fallbackFrom.length > 0 ? { fallbackFrom } : {}),
  };
}
