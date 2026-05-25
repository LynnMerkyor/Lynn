import { Hono } from "hono";
import { getRuntimeDiagnostics } from "../diagnostics.js";

type DebugRouteEngine = {
  currentModel?: {
    id?: string | null;
    name?: string | null;
    provider?: string | null;
  } | null;
  currentSessionPath?: string | null;
  mcpManager?: {
    listServerStates?: () => unknown[];
  } | null;
};

export function createDebugRoute(engine: DebugRouteEngine): Hono {
  const route = new Hono();

  route.get("/debug/runtime", async (c) => {
    try {
      return c.json(getRuntimeDiagnostics(engine));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  return route;
}
