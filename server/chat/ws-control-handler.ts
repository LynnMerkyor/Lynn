import { wsSend } from "../ws-protocol.js";
import { t } from "../i18n.js";
import { resumeSessionStream } from "../session-stream-store.js";

export interface WsControlHandlerDeps {
  engine: any;
  hub: any;
  sessionState: { get(sessionPath: any): any };
  broadcast: (msg: any) => void;
}

export function createWsControlHandler({
  engine,
  hub,
  sessionState,
  broadcast,
}: WsControlHandlerDeps) {
  return async function handleWsControlMessage(msg: Record<string, any>, ws: any) {
    if (msg.type === "abort") {
      const abortPath = msg.sessionPath || engine.currentSessionPath;
      if (engine.isSessionStreaming(abortPath)) {
        try {
          await hub.abort(abortPath);
        } catch (err: any) {
          console.warn("[chat] abort failed:", err?.message || err);
        }
      }
      return true;
    }

    if (msg.type === "resume_stream") {
      const currentPath = msg.sessionPath || engine.currentSessionPath;
      const ss = sessionState.get(currentPath);
      if (ss) {
        const resumed = resumeSessionStream(ss, {
          streamId: typeof msg.streamId === "string" ? msg.streamId : null,
          sinceSeq: Number(msg.sinceSeq || 0),
        });
        wsSend(ws, {
          type: "stream_resume",
          sessionPath: currentPath,
          streamId: resumed.streamId,
          sinceSeq: resumed.sinceSeq,
          nextSeq: resumed.nextSeq,
          reset: resumed.reset,
          truncated: resumed.truncated,
          isStreaming: resumed.isStreaming,
          events: resumed.events,
        });
      } else {
        wsSend(ws, {
          type: "stream_resume",
          sessionPath: currentPath,
          streamId: null,
          sinceSeq: Number.isFinite(Number(msg.sinceSeq)) ? Math.max(0, Number(msg.sinceSeq)) : 0,
          nextSeq: 1,
          reset: false,
          truncated: false,
          isStreaming: false,
          events: [],
        });
      }
      return true;
    }

    if (msg.type === "context_usage") {
      const usagePath = msg.sessionPath || engine.currentSessionPath;
      const usageSession = engine.getSessionByPath(usagePath);
      const usage = usageSession?.getContextUsage?.();
      wsSend(ws, {
        type: "context_usage",
        sessionPath: usagePath,
        tokens: usage?.tokens ?? null,
        contextWindow: usage?.contextWindow ?? null,
        percent: usage?.percent ?? null,
      });
      return true;
    }

    if (msg.type === "compact") {
      const compactPath = msg.sessionPath || engine.currentSessionPath;
      const session = engine.getSessionByPath(compactPath);
      if (!session) {
        wsSend(ws, { type: "error", message: t("error.noActiveSession") });
        return true;
      }
      if (session.isCompacting) {
        wsSend(ws, { type: "error", message: t("error.compacting") });
        return true;
      }
      if (engine.isSessionStreaming(compactPath)) {
        wsSend(ws, { type: "error", message: t("error.waitForReply") });
        return true;
      }
      broadcast({ type: "compaction_start", sessionPath: compactPath });
      try {
        await session.compact();
        const usage = session.getContextUsage?.();
        broadcast({
          type: "compaction_end",
          sessionPath: compactPath,
          tokens: usage?.tokens ?? null,
          contextWindow: usage?.contextWindow ?? null,
          percent: usage?.percent ?? null,
        });
      } catch (err: any) {
        const errMsg = err.message || "";
        broadcast({ type: "compaction_end", sessionPath: compactPath });
        if (!errMsg.includes("Already compacted") && !errMsg.includes("Nothing to compact")) {
          wsSend(ws, { type: "error", message: t("error.compactFailed", { msg: errMsg }) });
        }
      }
      return true;
    }

    if (msg.type === "toggle_plan_mode") {
      const current = engine.planMode;
      engine.setPlanMode(!current);
      broadcast({ type: "plan_mode", enabled: !current });
      broadcast({ type: "security_mode", mode: !current ? "plan" : "authorized" });
      return true;
    }

    return false;
  };
}
