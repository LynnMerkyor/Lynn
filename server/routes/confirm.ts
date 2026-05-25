/**
 * confirm.js — 阻塞式确认 REST API
 *
 * 前端渲染确认卡片后，用户通过此 API resolve pending confirmation。
 */

import { Hono } from "hono";
import { safeJson } from "../hono-helpers.js";

type ConfirmAction =
  | "confirmed"
  | "rejected"
  | "confirmed_once"
  | "confirmed_session"
  | "confirmed_persistent";

type ConfirmBody = {
  action?: unknown;
  value?: unknown;
};

type PendingConfirmation = {
  sessionPath?: string | null;
};

interface ConfirmStore {
  peek?: (confirmId: string) => PendingConfirmation | null | undefined;
  resolve(confirmId: string, action: ConfirmAction, value: unknown): boolean;
}

interface ConfirmRouteEngine {
  emitEvent(
    event: {
      type: "confirmation_resolved";
      confirmId: string;
      action: ConfirmAction;
      value: unknown;
    },
    sessionPath: string | null,
  ): unknown;
}

const VALID_ACTIONS = new Set<ConfirmAction>([
  "confirmed",
  "rejected",
  "confirmed_once",
  "confirmed_session",
  "confirmed_persistent",
]);

export function createConfirmRoute(confirmStore: ConfirmStore, engine: ConfirmRouteEngine): Hono {
  const route = new Hono();

  route.post("/confirm/:confirmId", async (c) => {
    const confirmId = c.req.param("confirmId");
    const body = await safeJson(c) as ConfirmBody;
    const { action, value } = body;

    if (typeof action !== "string" || !VALID_ACTIONS.has(action as ConfirmAction)) {
      return c.json({
        error: "action must be one of: confirmed, rejected, confirmed_once, confirmed_session, confirmed_persistent",
      }, 400);
    }
    const validAction = action as ConfirmAction;

    const pendingEntry = typeof confirmStore.peek === "function" ? confirmStore.peek(confirmId) : null;
    const found = confirmStore.resolve(confirmId, validAction, value);
    if (!found) {
      return c.json({ error: "confirmation not found or already resolved" }, 404);
    }

    // 广播状态变更，让前端更新卡片
    engine.emitEvent({
      type: "confirmation_resolved",
      confirmId,
      action: validAction,
      value,
    }, pendingEntry?.sessionPath || null);

    return c.json({ ok: true });
  });

  return route;
}
