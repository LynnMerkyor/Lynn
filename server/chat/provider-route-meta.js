export function normalizeProviderFallbackHop(raw) {
  const id = String(raw?.id || raw?.provider || raw?.providerId || raw?.name || "").trim();
  if (!id) return null;
  const reason = String(raw?.reason || raw?.status || raw?.error || "").trim().slice(0, 160);
  return reason ? { id, reason } : { id };
}

export function extractProviderRouteMeta(event) {
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
    source.activeProvider
    || source.active_provider
    || source.providerId
    || source.provider
    || event.activeProvider
    || event.active_provider
    || "",
  ).trim();
  if (!activeProvider) return null;
  const rawFallback = Array.isArray(source.fallbackFrom)
    ? source.fallbackFrom
    : (Array.isArray(source.fallback_from)
      ? source.fallback_from
      : (Array.isArray(event.fallbackFrom) ? event.fallbackFrom : event.fallback_from));
  const fallbackFrom = Array.isArray(rawFallback)
    ? rawFallback.map(normalizeProviderFallbackHop).filter(Boolean).slice(0, 8)
    : [];
  return {
    activeProvider,
    ...(fallbackFrom.length > 0 ? { fallbackFrom } : {}),
  };
}
