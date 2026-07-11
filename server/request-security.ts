function hostnameFromHostHeader(hostHeader: string): string {
  const raw = String(hostHeader || "").trim();
  if (!raw) return "";
  try {
    return new URL(`http://${raw}`).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return "";
  }
}

export function isLoopbackHostHeader(hostHeader: string | null | undefined): boolean {
  const hostname = hostnameFromHostHeader(String(hostHeader || ""));
  return hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname === "127.0.0.1"
    || hostname === "::1";
}

export function isAllowedLocalOrigin(
  origin: string | null | undefined,
  configuredOrigin?: string | null,
): boolean {
  const value = String(origin || "").trim();
  if (!value) return true;
  // Packaged Electron file renderers use an opaque origin. Requests still need
  // the per-launch bearer token and a loopback Host header.
  if (value === "null" || value === "file://") return true;
  if (configuredOrigin) return value === configuredOrigin;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return isLoopbackHostHeader(parsed.host);
  } catch {
    return false;
  }
}

export function isTrustedLocalRequest(input: {
  host?: string | null;
  origin?: string | null;
  configuredOrigin?: string | null;
}): boolean {
  return isLoopbackHostHeader(input.host)
    && isAllowedLocalOrigin(input.origin, input.configuredOrigin);
}
