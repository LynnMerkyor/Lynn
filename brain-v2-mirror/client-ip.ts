import type { IncomingMessage } from 'node:http';

type HeaderValue = string | string[] | undefined;
type ResolveClientIpOptions = { trustProxyHeaders?: boolean };

function firstHeaderValue(value: HeaderValue): string {
  if (Array.isArray(value)) return String(value[0] || '');
  return String(value || '');
}

export function normalizeClientIp(value: unknown): string {
  let ip = String(value || '').trim();
  if (!ip || ip.toLowerCase() === 'unknown') return '';
  if (ip.includes(',')) ip = ip.split(',')[0]?.trim() || '';
  ip = ip.replace(/^"|"$/g, '');
  if (ip.startsWith('::ffff:')) ip = ip.slice('::ffff:'.length);
  const bracketMatch = ip.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketMatch) return bracketMatch[1] || '';
  const ipv4PortMatch = ip.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (ipv4PortMatch) return ipv4PortMatch[1] || '';
  return ip;
}

function isLoopbackIp(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}

export function resolveClientIp(
  req: Pick<IncomingMessage, 'headers' | 'socket'>,
  options: ResolveClientIpOptions = {},
): string {
  const headers = req.headers || {};
  const socketIp = normalizeClientIp(req.socket?.remoteAddress);
  const trustProxyHeaders = options.trustProxyHeaders ?? isLoopbackIp(socketIp);
  if (trustProxyHeaders) {
    const realIp = normalizeClientIp(firstHeaderValue(headers['x-real-ip']));
    if (realIp) return realIp;

    const forwardedFor = normalizeClientIp(firstHeaderValue(headers['x-forwarded-for']));
    if (forwardedFor) return forwardedFor;
  }

  return socketIp || 'unknown';
}
