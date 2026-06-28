import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createToolTurnFinalizer } from "../server/chat/tool-turn-finalizer.js";

const tempDirs: string[] = [];

function makeTempSessionFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-finalizer-"));
  tempDirs.push(dir);
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(file, `${JSON.stringify({
    type: "message",
    id: "u1",
    parentId: null,
    timestamp: new Date().toISOString(),
    message: {
      role: "user",
      content: [{ type: "text", text: "抓一下" }],
      timestamp: Date.now(),
    },
  })}\n`, "utf-8");
  return file;
}

describe("tool turn finalizer fallback persistence", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists visible fallback text when a hard-empty BYOK turn closes", () => {
    const sessionPath = makeTempSessionFile();
    const session = {
      messages: [
        { role: "user", content: [{ type: "text", text: "抓一下" }], timestamp: Date.now() },
      ],
    };
    const ss: any = {
      streamId: "stream-test",
      nextSeq: 1,
      events: [],
      maxEvents: 50,
      visibleTextAcc: "",
      hasOutput: false,
      isThinking: false,
      activeStreamToken: "tok",
    };
    let emittedText = "";
    const finalizer = createToolTurnFinalizer({
      engine: {
        getSessionByPath: vi.fn(() => session),
      },
      editRollbackStore: { discardPendingForSession: vi.fn() },
      lifecycleHooks: { run: vi.fn() },
      broadcast: vi.fn(),
      emitStreamEvent: vi.fn((_: string, state: any, event: any) => {
        state.events.push({ event });
      }),
      emitTrustedVisibleTextDelta: vi.fn((_: string, state: any, delta: unknown) => {
        state.hasOutput = true;
        state.visibleTextAcc += String(delta || "");
        emittedText += String(delta || "");
        return true;
      }),
      emitVisibleTextDelta: vi.fn(),
      flushBufferedAssistantText: vi.fn(),
      flushBufferedToolVisibleText: vi.fn(),
      maybeAppendCodeVerificationPostscript: vi.fn(() => false),
      hasStreamEvent: vi.fn(() => false),
      hasScheduledInternalRetry: vi.fn(() => false),
      hasToolExecutionInFlight: vi.fn(() => false),
      hasDifferentActiveStreamToken: vi.fn(() => false),
      timeouts: {
        returnedTurnFinalizationGraceMs: 1,
        turnHardAbortMs: 1,
        turnLongResearchHardAbortMs: 1,
        toolFinalizationGraceMs: 1,
        toolAuthorizationGraceMs: 1,
      },
    });

    const fallback = "模型这次没有返回可见内容。本轮已安全结束。";
    expect(finalizer.closeStreamWithVisibleFallback(sessionPath, ss, fallback, "test_empty", { trustedFallback: true })).toBe(true);

    const lines = fs.readFileSync(sessionPath, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.at(-1)?.message?.role).toBe("assistant");
    expect(lines.at(-1)?.message?.content?.[0]?.text).toContain("模型这次没有返回可见内容");
    expect(session.messages.at(-1)?.role).toBe("assistant");
    expect(session.messages.at(-1)?.content?.[0]?.text).toContain("模型这次没有返回可见内容");
  });

  it("sanitizes persisted final text after tool evidence before closing", () => {
    const sessionPath = makeTempSessionFile();
    const badFinalText = "针对“查一下深圳 2026 年社保缴费政策有没有最新变化，给来源和不确定点”，我能从工具证据中确认：- 北京2023年的最低工资标准为2320元。";
    fs.appendFileSync(sessionPath, `${JSON.stringify({
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: badFinalText }],
        timestamp: Date.now(),
      },
    })}\n`, "utf-8");
    const session = {
      messages: [
        { role: "user", content: [{ type: "text", text: "查一下深圳 2026 年社保缴费政策有没有最新变化，给来源和不确定点" }], timestamp: Date.now() },
        { role: "assistant", content: [{ type: "text", text: badFinalText }], timestamp: Date.now() },
      ],
    };
    const ss: any = {
      streamId: "stream-test",
      nextSeq: 1,
      events: [],
      maxEvents: 50,
      visibleTextAcc: "",
      hasOutput: false,
      hasToolCall: true,
      successfulToolCount: 1,
      lastSuccessfulTools: [{
        name: "web_search",
        command: "",
        filePath: "",
        outputPreview: "来源：深圳市人力资源和社会保障局\n摘要：2026 年社保缴费基数口径以官方公告为准。",
      }],
      isThinking: false,
      activeStreamToken: "tok",
    };
    let emittedText = "";
    const finalizer = createToolTurnFinalizer({
      engine: {
        getSessionByPath: vi.fn(() => session),
      },
      editRollbackStore: { discardPendingForSession: vi.fn() },
      lifecycleHooks: { run: vi.fn() },
      broadcast: vi.fn(),
      emitStreamEvent: vi.fn((_: string, state: any, event: any) => {
        state.events.push({ event });
      }),
      emitTrustedVisibleTextDelta: vi.fn((_: string, state: any, delta: unknown) => {
        state.hasOutput = true;
        state.visibleTextAcc += String(delta || "");
        emittedText += String(delta || "");
        return true;
      }),
      emitVisibleTextDelta: vi.fn(),
      flushBufferedAssistantText: vi.fn(),
      flushBufferedToolVisibleText: vi.fn(),
      maybeAppendCodeVerificationPostscript: vi.fn(() => false),
      hasStreamEvent: vi.fn(() => false),
      hasScheduledInternalRetry: vi.fn(() => false),
      hasToolExecutionInFlight: vi.fn(() => false),
      hasDifferentActiveStreamToken: vi.fn(() => false),
      timeouts: {
        returnedTurnFinalizationGraceMs: 1,
        turnHardAbortMs: 1,
        turnLongResearchHardAbortMs: 1,
        toolFinalizationGraceMs: 1,
        toolAuthorizationGraceMs: 1,
      },
    });

    expect(finalizer.finalizeReturnedTurnWithoutStream(sessionPath, ss, "returned_closed", { requirePersistedText: true })).toBe(true);
    expect(emittedText).toContain("深圳市人力资源和社会保障局");
    expect(emittedText).not.toContain("工具证据中确认");
    expect(emittedText).not.toContain("北京2023");
  });
});
