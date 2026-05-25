export interface RequestAuthTokenInput {
  authorization?: string | null;
  protocolHeader?: string | null;
  cookieHeader?: string | null;
}

export function readCookieValue(cookieHeader: string | null | undefined, name: string): string {
  if (!cookieHeader || !name) return "";
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${name}=`)) continue;
    const value = trimmed.slice(name.length + 1);
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return "";
}

export function resolveRequestAuthToken({
  authorization,
  protocolHeader,
  cookieHeader,
}: RequestAuthTokenInput): string {
  const headerToken = authorization?.replace(/^Bearer\s+/i, "") || "";
  if (headerToken) return headerToken;

  const protocolToken = String(protocolHeader || "")
    .split(',')
    .map((value) => value.trim())
    .find((value) => value.startsWith('token.'))
    ?.slice(6);
  if (protocolToken) return protocolToken;

  return readCookieValue(cookieHeader, 'hana_token');
}
