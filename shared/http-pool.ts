import { Agent } from "undici";

const pools = new Map<string, Agent>();

function normalizePoolKey(baseUrl: unknown): string {
  try {
    const url = new URL(String(baseUrl || ""));
    return `${url.protocol}//${url.host}`;
  } catch {
    return String(baseUrl || "").trim();
  }
}

export function getPooledDispatcher(baseUrl: unknown): Agent | null {
  const key = normalizePoolKey(baseUrl);
  if (!key) return null;
  if (!pools.has(key)) {
    pools.set(key, new Agent({
      connections: 4,
      pipelining: 1,
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 60_000,
      connect: {
        timeout: 10_000,
      },
    }));
  }
  return pools.get(key) || null;
}

type PrewarmOptions = {
  method?: string;
  headers?: HeadersInit;
  timeoutMs?: number;
};

export async function prewarmHttpConnection(url: string | URL, {
  method = "HEAD",
  headers = {},
  timeoutMs = 3000,
}: PrewarmOptions = {}): Promise<Response> {
  const dispatcher = getPooledDispatcher(url);
  const init: RequestInit & { dispatcher?: Agent } = {
    method,
    headers,
    dispatcher: dispatcher || undefined,
    signal: AbortSignal.timeout(timeoutMs),
  };
  return fetch(url, init);
}

export async function closeHttpPools(): Promise<void> {
  const closers = [...pools.values()].map((agent) => agent.close().catch(() => {}));
  pools.clear();
  await Promise.allSettled(closers);
}
