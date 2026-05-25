type RuntimeDiagnosticsPayload = Record<string, unknown> & { at?: string };

interface RuntimeDiagnosticsState {
  current: RuntimeDiagnosticsPayload | null;
  lastToolCall: RuntimeDiagnosticsPayload | null;
  lastFallback: RuntimeDiagnosticsPayload | null;
  lastProviderIssue: RuntimeDiagnosticsPayload | null;
}

interface RuntimeMcpDiagnostics {
  name?: string;
  label?: string;
  transport?: string;
  connected: boolean;
  builtin: boolean;
  toolCount: number;
  error: unknown;
}

interface McpServerState {
  name?: string;
  label?: string;
  transport?: string;
  connected?: boolean;
  builtin?: boolean;
  toolCount?: number;
  error?: unknown;
}

interface DiagnosticsEngine {
  currentModel?: {
    provider?: string | null;
    id?: string | null;
    name?: string | null;
  } | null;
  currentSessionPath?: string | null;
  mcpManager?: {
    listServerStates?: () => unknown[];
  } | null;
}

const runtimeDiagnostics: RuntimeDiagnosticsState = {
  current: null,
  lastToolCall: null,
  lastFallback: null,
  lastProviderIssue: null,
};

function withTimestamp(payload: RuntimeDiagnosticsPayload = {}): RuntimeDiagnosticsPayload {
  return {
    at: new Date().toISOString(),
    ...payload,
  };
}

function clone<T>(value: T | null): T | null {
  return value ? JSON.parse(JSON.stringify(value)) as T : null;
}

function normalizeIssueKind(message: unknown = "", code: unknown = ""): string {
  const text = `${code || ""} ${message || ""}`.toLowerCase();
  if (text.includes("429")) return "429";
  if (text.includes("400")) return "400";
  if (text.includes("timeout") || text.includes("timed out")) return "timeout";
  return String(code || "error");
}

export function recordCurrentProvider(payload: RuntimeDiagnosticsPayload = {}): void {
  runtimeDiagnostics.current = withTimestamp(payload);
}

export function recordToolCall(payload: RuntimeDiagnosticsPayload = {}): void {
  runtimeDiagnostics.lastToolCall = withTimestamp(payload);
}

export function recordFallback(payload: RuntimeDiagnosticsPayload = {}): void {
  runtimeDiagnostics.lastFallback = withTimestamp(payload);
}

export function recordProviderIssue(payload: RuntimeDiagnosticsPayload = {}): void {
  runtimeDiagnostics.lastProviderIssue = withTimestamp({
    kind: normalizeIssueKind(payload.message, payload.code),
    ...payload,
  });
}

export function getRuntimeDiagnostics(engine?: DiagnosticsEngine | null) {
  const currentModel = engine?.currentModel || null;
  let mcp: RuntimeMcpDiagnostics[] = [];
  try {
    mcp = engine?.mcpManager?.listServerStates?.()?.map((rawServer) => {
      const server = rawServer as McpServerState;
      return {
      name: server.name,
      label: server.label || server.name,
      transport: server.transport,
      connected: !!server.connected,
      builtin: !!server.builtin,
      toolCount: Number(server.toolCount || 0),
      error: server.error || null,
      };
    }) || [];
  } catch {
    mcp = [];
  }

  return {
    current: clone(runtimeDiagnostics.current) || {
      at: new Date().toISOString(),
      provider: currentModel?.provider || null,
      modelId: currentModel?.id || null,
      modelName: currentModel?.name || currentModel?.id || null,
      routeIntent: null,
      sessionPath: engine?.currentSessionPath || null,
    },
    lastToolCall: clone(runtimeDiagnostics.lastToolCall),
    lastFallback: clone(runtimeDiagnostics.lastFallback),
    lastProviderIssue: clone(runtimeDiagnostics.lastProviderIssue),
    mcp,
  };
}
