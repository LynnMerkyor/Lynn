import { Hono } from "hono";
import fsPromises from "fs/promises";
import os from "os";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const reportResearchMock = vi.hoisted(() => ({
  buildReportResearchContext: vi.fn(),
  buildDirectResearchAnswer: vi.fn(),
  inferReportResearchKind: vi.fn(),
}));

vi.mock("../server/chat/report-research-context.js", () => reportResearchMock);

import { createChatRoute } from "../server/routes/chat.js";

function makeWebSocketHarness() {
  const clients = [];
  const connections = [];
  const upgradeWebSocket = (factory) => (c) => {
    const client = {
      readyState: 1,
      sent: [],
      close: vi.fn(),
      send(payload) {
        this.sent.push(JSON.parse(payload));
      },
    };
    clients.push(client);
    const handlers = factory(c);
    connections.push({ client, handlers });
    handlers.onOpen?.({}, client);
    return new Response(null, { status: 200 });
  };
  return { clients, connections, upgradeWebSocket };
}

function waitForAsyncHandlers() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("chat route event forwarding", () => {
  let subscribed;
  let hub;
  let engine;
  let app;
  let clients;
  let connections;
  let editRollbackStore;

  beforeEach(() => {
    subscribed = null;
    hub = {
      subscribe: vi.fn((handler) => {
        subscribed = handler;
        return () => {};
      }),
    };
    engine = {
      currentSessionPath: "/sessions/current.jsonl",
      createSession: vi.fn(async () => ({
        sessionManager: { getSessionFile: () => "/sessions/current.jsonl" },
      })),
      resolveModelOverrides: vi.fn((model) => model),
      abortAllStreaming: vi.fn(async () => 0),
      getSessionByPath: vi.fn(() => ({ messages: [] })),
      listSessions: vi.fn(async () => []),
      isSessionStreaming: vi.fn(() => false),
      truncateSessionBeforeVisibleMessage: vi.fn(async () => ({ ok: true })),
      promptSession: vi.fn(),
      steerSession: vi.fn(() => false),
      abortSession: vi.fn(() => false),
      cwd: process.cwd(),
    };
    reportResearchMock.buildReportResearchContext.mockResolvedValue("");
    reportResearchMock.buildDirectResearchAnswer.mockReturnValue("");
    reportResearchMock.inferReportResearchKind.mockReturnValue("");
    const wsHarness = makeWebSocketHarness();
    clients = wsHarness.clients;
    connections = wsHarness.connections;
    const route = createChatRoute(engine, hub, { upgradeWebSocket: wsHarness.upgradeWebSocket });
    editRollbackStore = route.editRollbackStore;
    app = new Hono();
    app.route("", route.wsRoute);
  });

  it("rewinds a session before accepting an edit-resend prompt", async () => {
    hub.send = vi.fn(() => new Promise(() => {}));
    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "改后的问题", replaceFromMessageId: "user-1718000000000", replaceFromMessageIndex: 2 }),
    }, connections[0].client);
    await waitForAsyncHandlers();

    expect(engine.truncateSessionBeforeVisibleMessage).toHaveBeenCalledWith("/sessions/current.jsonl", "2");
    expect(clients[0].sent).toContainEqual(expect.objectContaining({
      type: "prompt_accepted",
      sessionPath: "/sessions/current.jsonl",
    }));
    expect(hub.send).toHaveBeenCalled();
  });

  it("releases a stale stream before accepting and rewinding an edit-resend prompt", async () => {
    const order = [];
    engine.isSessionStreaming = vi.fn(() => true);
    engine.abortSessionByPath = vi.fn(async () => {
      order.push("abort");
      return true;
    });
    engine.truncateSessionBeforeVisibleMessage = vi.fn(async () => {
      order.push("truncate");
      return { ok: true };
    });
    hub.send = vi.fn(() => {
      order.push("send");
      return new Promise(() => {});
    });
    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    const client = connections[0].client;
    client.send = vi.fn(function send(payload) {
      const event = JSON.parse(payload);
      this.sent.push(event);
      if (event.type === "prompt_accepted" || event.type === "turn_end" || event.type === "status") {
        order.push(event.type);
      }
    });

    connections[0].handlers.onMessage({
      data: JSON.stringify({
        type: "prompt",
        text: "基于上面的工具结果直接总结",
        replaceFromMessageId: "user-1718000000000",
        replaceFromMessageIndex: 2,
      }),
    }, client);
    await waitForAsyncHandlers();

    expect(engine.abortSessionByPath).toHaveBeenCalledWith("/sessions/current.jsonl");
    expect(engine.truncateSessionBeforeVisibleMessage).toHaveBeenCalledWith("/sessions/current.jsonl", "2");
    expect(hub.send).toHaveBeenCalled();
    expect(order.indexOf("abort")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("truncate")).toBeGreaterThan(order.indexOf("abort"));
    expect(order.indexOf("prompt_accepted")).toBeGreaterThan(order.indexOf("truncate"));
    expect(order.indexOf("send")).toBeGreaterThan(order.indexOf("prompt_accepted"));
    expect(client.sent).not.toContainEqual(expect.objectContaining({
      type: "error",
      message: expect.stringContaining("still"),
    }));
  });

  it("does not append a prompt when edit-resend cannot find the target message", async () => {
    engine.truncateSessionBeforeVisibleMessage.mockResolvedValueOnce({ ok: false, reason: "message-not-found" });
    hub.send = vi.fn(() => new Promise(() => {}));
    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "改后的问题", replaceFromMessageId: "missing" }),
    }, connections[0].client);
    await waitForAsyncHandlers();

    expect(clients[0].sent).toContainEqual(expect.objectContaining({
      type: "error",
      sessionPath: "/sessions/current.jsonl",
    }));
    expect(clients[0].sent.some((event) => event.type === "prompt_accepted")).toBe(false);
    expect(hub.send).not.toHaveBeenCalled();
  });

  it("forwards tool_authorization events to websocket clients", async () => {
    const res = await app.request("/ws");
    expect(res.status).toBe(200);
    expect(typeof subscribed).toBe("function");
    hub.send = vi.fn(() => new Promise(() => {}));

    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "请执行终端命令 echo hi" }),
    }, connections[0].client);

    subscribed({
      type: "tool_authorization",
      confirmId: "confirm-1",
      command: "sudo rm -rf /tmp/test",
      reason: "blocked",
      description: "needs confirmation",
      category: "elevated_command",
      identifier: "sudo",
    }, "/sessions/current.jsonl");

    expect(clients).toHaveLength(1);
    expect(clients[0].sent).toContainEqual(expect.objectContaining({
      type: "tool_authorization",
      sessionPath: "/sessions/current.jsonl",
      confirmId: "confirm-1",
      command: "sudo rm -rf /tmp/test",
      category: "elevated_command",
    }));
  });

  it("captures edit snapshots and emits rollbackId on file_diff events", async () => {
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "lynn-chat-route-"));
    const filePath = path.join(tmpDir, "sample.txt");
    try {
      await fsPromises.writeFile(filePath, "before\n", "utf8");
      engine.getSessionByPath = vi.fn(() => ({
        sessionManager: { getCwd: () => tmpDir },
        messages: [],
      }));
      hub.send = vi.fn(() => new Promise(() => {}));

      const res = await app.request("/ws");
      expect(res.status).toBe(200);

      connections[0].handlers.onMessage({
        data: JSON.stringify({ type: "prompt", text: "请修改 sample.txt" }),
      }, connections[0].client);

      subscribed({
        type: "tool_execution_start",
        toolCallId: "call_123",
        toolName: "edit",
        args: { path: "sample.txt" },
      }, "/sessions/current.jsonl");

      await fsPromises.writeFile(filePath, "after\n", "utf8");

      subscribed({
        type: "tool_execution_end",
        toolCallId: "call_123",
        toolName: "edit",
        args: { path: "sample.txt" },
        result: { details: { diff: "@@ -1 +1 @@\n-before\n+after" } },
        isError: false,
      }, "/sessions/current.jsonl");

      expect(clients[0].sent).toContainEqual(expect.objectContaining({
        type: "file_diff",
        rollbackId: "call_123",
        filePath: "sample.txt",
      }));

      expect(editRollbackStore.get("call_123")).toEqual(expect.objectContaining({
        rollbackId: "call_123",
        filePath,
        originalContent: "before\n",
      }));
    } finally {
      await fsPromises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("broadcasts security_mode updates", async () => {
    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    subscribed({ type: "security_mode", mode: "safe" }, "/sessions/current.jsonl");

    expect(clients[0].sent).toContainEqual({ type: "security_mode", mode: "safe" });
  });

  it("suppresses pseudo-tool XML without steering Brain default model text", async () => {
    engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    engine.steerSession = vi.fn(() => true);
    hub.send = vi.fn(() => new Promise(() => {}));

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "明天深圳天气如何" }),
    }, connections[0].client);

    subscribed({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: '<web_search>\n深圳 2026年4月28日 天气预报\n</web_search>',
      },
    }, "/sessions/current.jsonl");
    subscribed({ type: "turn_end" }, "/sessions/current.jsonl");

    expect(engine.steerSession).not.toHaveBeenCalled();
    expect(clients[0].sent
      .filter((evt) => evt.type === "text_delta")
      .map((evt) => evt.delta)
      .join("")).not.toContain("<web_search>");
  });

  it("suppresses pseudo-tool function text for non-Brain model text without steering", async () => {
    engine.currentModel = { id: "kimi-k2.5", provider: "moonshot", name: "Kimi K2.5" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    engine.steerSession = vi.fn(() => true);
    hub.send = vi.fn(() => new Promise(() => {}));

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "帮我查一下深圳天气" }),
    }, connections[0].client);

    subscribed({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: 'web_search(query="深圳天气")',
      },
    }, "/sessions/current.jsonl");
    subscribed({ type: "turn_end" }, "/sessions/current.jsonl");

    expect(engine.steerSession).not.toHaveBeenCalled();
    const visibleText = clients[0].sent
      .filter((evt) => evt.type === "text_delta")
      .map((evt) => evt.delta)
      .join("");
    expect(visibleText).not.toContain("web_search");
  });

  it("suppresses pseudo bash XML even after a real tool call already ran", async () => {
    engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    engine.steerSession = vi.fn(() => true);
    hub.send = vi.fn(() => new Promise(() => {}));

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "移动下载文件夹的 pdf 文件到 pdf 文件夹" }),
    }, connections[0].client);

    subscribed({
      type: "tool_execution_start",
      toolCallId: "call_ls",
      toolName: "bash",
      args: { command: "ls -la /Users/licheng/Downloads | head" },
    }, "/sessions/current.jsonl");
    subscribed({
      type: "tool_execution_end",
      toolCallId: "call_ls",
      toolName: "bash",
      args: { command: "ls -la /Users/licheng/Downloads | head" },
      result: { output: "a.pdf\nb.pdf\n" },
      isError: false,
    }, "/sessions/current.jsonl");

    subscribed({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: [
          "好的，我来执行。先创建 PDF 文件夹，然后移动所有 PDF 文件。",
          "",
          "<bash>",
          "mkdir -p \"/Users/licheng/Downloads/pdf\"",
          "find \"/Users/licheng/Downloads\" -maxdepth 1 -type f -iname \"*.pdf\" -exec mv {} \"/Users/licheng/Downloads/pdf/\" \\;",
          "</bash>",
        ].join("\n"),
      },
    }, "/sessions/current.jsonl");

    expect(engine.steerSession).not.toHaveBeenCalled();
    const visibleText = clients[0].sent
      .filter((evt) => evt.type === "text_delta")
      .map((evt) => evt.delta)
      .join("");
    expect(visibleText).toContain("好的，我来执行。");
    expect(visibleText).not.toContain("<bash>");
    expect(visibleText).not.toContain("mkdir -p");
  });

  it("suppresses fragmented pseudo web_search XML across streaming chunks", async () => {
    engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    engine.steerSession = vi.fn(() => true);
    hub.send = vi.fn(() => new Promise(() => {}));

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "明天深圳会下雨吗？" }),
    }, connections[0].client);

    subscribed({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "<web_search>" },
    }, "/sessions/current.jsonl");
    subscribed({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "\n深圳 2026年4月28日 天气预报\n" },
    }, "/sessions/current.jsonl");
    subscribed({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "</web_search>" },
    }, "/sessions/current.jsonl");
    subscribed({ type: "turn_end" }, "/sessions/current.jsonl");

    expect(engine.steerSession).not.toHaveBeenCalled();
    const visibleText = clients[0].sent
      .filter((evt) => evt.type === "text_delta")
      .map((evt) => evt.delta)
      .join("");
    expect(visibleText).not.toContain("<web_search>");
    expect(visibleText).not.toContain("</web_search>");
  });

  it("suppresses pseudo-tool XML without retrying Brain when a thinking-only turn ends", async () => {
    engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    engine.steerSession = vi.fn(() => true);
    hub.send = vi.fn(() => Promise.resolve());

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "请检查下载文件夹里有哪些后缀为 zip 的文件，只列出文件名和数量，不要删除任何文件。" }),
    }, connections[0].client);

    subscribed({
      type: "thinking_delta",
      delta: "我需要使用工具检查下载文件夹。",
    }, "/sessions/current.jsonl");
    subscribed({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "<bash>\nfind ~/Downloads -maxdepth 1 -type f -iname '*.zip'\n</bash>",
      },
    }, "/sessions/current.jsonl");
    subscribed({ type: "turn_end" }, "/sessions/current.jsonl");

    await vi.waitFor(() => expect(hub.send).toHaveBeenCalledTimes(1), { timeout: 1000 });
    const visibleText = clients[0].sent
      .filter((evt) => evt.type === "text_delta")
      .map((evt) => evt.delta)
      .join("");
    expect(visibleText).not.toContain("<bash>");
    expect(clients[0].sent).not.toContainEqual(expect.objectContaining({
      type: "turn_retry",
    }));
  });

  it("shows a visible fallback when a turn ends with reasoning only and no answer", async () => {
    engine.currentModel = { id: "deepseek-v4-pro", provider: "deepseek", name: "DeepSeek V4 Pro" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    hub.send = vi.fn(() => new Promise(() => {}));

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "你好" }),
    }, connections[0].client);

    await vi.waitFor(() => expect(hub.send).toHaveBeenCalledTimes(1), { timeout: 1000 });

    subscribed({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        delta: "我需要先思考一下。",
      },
    }, "/sessions/current.jsonl");
    subscribed({ type: "turn_end" }, "/sessions/current.jsonl");

    const visibleText = clients[0].sent
      .filter((evt) => evt.type === "text_delta")
      .map((evt) => evt.delta)
      .join("");
    expect(visibleText).toContain("模型这次只返回了思考过程");
    expect(clients[0].sent).toContainEqual(expect.objectContaining({
      type: "turn_end",
      sessionPath: "/sessions/current.jsonl",
    }));
  });

  it("suppresses backend tool-template XML fragments across streaming chunks", async () => {
    engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    engine.steerSession = vi.fn(() => true);
    hub.send = vi.fn(() => new Promise(() => {}));

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "明天深圳会下雨吗？" }),
    }, connections[0].client);

    subscribed({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "<t" },
    }, "/sessions/current.jsonl");
    subscribed({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "avily>\n深圳天气\n</tavily>\n" },
    }, "/sessions/current.jsonl");
    subscribed({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "_calls></inv> </_calls>\n最终答案：建议带伞。" },
    }, "/sessions/current.jsonl");
    subscribed({ type: "turn_end" }, "/sessions/current.jsonl");

    expect(engine.steerSession).not.toHaveBeenCalled();
    const visibleText = clients[0].sent
      .filter((evt) => evt.type === "text_delta")
      .map((evt) => evt.delta)
      .join("");
    expect(visibleText).toContain("最终答案");
    expect(visibleText).not.toMatch(/tavily|_calls|<\/?inv/i);
  });

  it("does not defer turn_end or schedule internal retry for truncated-looking text", async () => {
    engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    hub.send = vi.fn(() => new Promise(() => {}));

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "详细介绍宋朝科举制度的演变、影响、对比，输出结构化长文。" }),
    }, connections[0].client);

    subscribed({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "## 宋朝科举制度\n\n| 阶段 | 特点 |\n|------|------|",
      },
    }, "/sessions/current.jsonl");
    subscribed({ type: "turn_end" }, "/sessions/current.jsonl");

    await Promise.resolve();

    expect(hub.send).toHaveBeenCalledTimes(1);
    expect(clients[0].sent).not.toContainEqual(expect.objectContaining({
      type: "turn_retry",
    }));
    expect(clients[0].sent.some((evt) => evt.type === "turn_end")).toBe(true);
  });

  it("does not retry when a real tool ran but the assistant only says it will continue executing", async () => {
    engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    hub.send = vi.fn(() => new Promise(() => {}));

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    const prompt = "把 /tmp/lynn-pdf-move-test 文件夹里的 pdf 文件移动到这个文件夹下新建的 pdf 文件夹里";
    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: prompt }),
    }, connections[0].client);

    subscribed({
      type: "tool_execution_start",
      toolCallId: "call_ls",
      toolName: "bash",
      args: { command: "ls -la /tmp/lynn-pdf-move-test" },
    }, "/sessions/current.jsonl");
    subscribed({
      type: "tool_execution_end",
      toolCallId: "call_ls",
      toolName: "bash",
      args: { command: "ls -la /tmp/lynn-pdf-move-test" },
      result: { output: "a.pdf\nb.PDF\nnote.txt\n" },
      isError: false,
    }, "/sessions/current.jsonl");
    subscribed({ type: "turn_end" }, "/sessions/current.jsonl");

    subscribed({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "找到 2 个 PDF 文件（`a.pdf` 和 `b.PDF`），开始创建文件夹并移动。",
      },
    }, "/sessions/current.jsonl");
    subscribed({ type: "turn_end" }, "/sessions/current.jsonl");

    await Promise.resolve();

    expect(clients[0].sent).not.toContainEqual(expect.objectContaining({
      type: "turn_retry",
    }));
    expect(hub.send).toHaveBeenCalledTimes(1);
  });

  it("does not retry when a local file mutation task only scanned files but claimed completion", async () => {
    engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    hub.send = vi.fn(() => new Promise(() => {}));

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    const prompt = "请把下载文件夹的所有 Excel 都放进表格的文件夹";
    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: prompt }),
    }, connections[0].client);

    const scanCommand = [
      "find ~/Downloads -maxdepth 1 -type f \\(",
      "-iname '*.xlsx' -o -iname '*.xls' -o -iname '*.csv'",
      "\\)",
    ].join(" ");
    subscribed({
      type: "tool_execution_start",
      toolCallId: "call_find_excel",
      toolName: "bash",
      args: { command: scanCommand },
    }, "/sessions/current.jsonl");
    subscribed({
      type: "tool_execution_end",
      toolCallId: "call_find_excel",
      toolName: "bash",
      args: { command: scanCommand },
      result: { output: Array.from({ length: 33 }, (_, idx) => `/Users/lynn/Downloads/file-${idx + 1}.xlsx`).join("\n") },
      isError: false,
    }, "/sessions/current.jsonl");
    subscribed({ type: "turn_end" }, "/sessions/current.jsonl");

    subscribed({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "找到33个Excel文件，现在全部移动到“表格”文件夹。",
      },
    }, "/sessions/current.jsonl");
    subscribed({ type: "turn_end" }, "/sessions/current.jsonl");

    await Promise.resolve();

    expect(clients[0].sent).not.toContainEqual(expect.objectContaining({
      type: "turn_retry",
    }));
    expect(hub.send).toHaveBeenCalledTimes(1);
  });

  it("does not retry when a download-folder delete task only scanned zip files", async () => {
    engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    hub.send = vi.fn(() => new Promise(() => {}));

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    const prompt = "请把下载文件夹的所有后缀 zip 的文件都删除";
    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: prompt }),
    }, connections[0].client);

    const scanCommand = "find ~/Downloads -maxdepth 1 -type f -iname '*.zip'";
    subscribed({
      type: "tool_execution_start",
      toolCallId: "call_find_zip",
      toolName: "bash",
      args: { command: scanCommand },
    }, "/sessions/current.jsonl");
    subscribed({
      type: "tool_execution_end",
      toolCallId: "call_find_zip",
      toolName: "bash",
      args: { command: scanCommand },
      result: { output: "/Users/lynn/Downloads/a.zip\n/Users/lynn/Downloads/b.zip\n" },
      isError: false,
    }, "/sessions/current.jsonl");
    subscribed({ type: "turn_end" }, "/sessions/current.jsonl");

    subscribed({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "找到2个 zip 文件，现在删除。",
      },
    }, "/sessions/current.jsonl");
    subscribed({ type: "turn_end" }, "/sessions/current.jsonl");

    await Promise.resolve();

    expect(clients[0].sent).not.toContainEqual(expect.objectContaining({
      type: "turn_retry",
    }));
    expect(hub.send).toHaveBeenCalledTimes(1);
  });

  it("does not retry when a local file mutation task only produces a preparatory lead-in without tools", async () => {
    engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    hub.send = vi.fn(() => new Promise(() => {}));

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    const prompt = "把当前目录下所有 Excel 和 CSV 表格文件都移动到一个新建的“表格”文件夹里";
    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: prompt }),
    }, connections[0].client);

    subscribed({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "我来帮你把当前目录下的 Excel 和 CSV 文件移动到新建的“表格”文件夹中。",
      },
    }, "/sessions/current.jsonl");
    subscribed({ type: "turn_end" }, "/sessions/current.jsonl");

    await Promise.resolve();

    expect(clients[0].sent).not.toContainEqual(expect.objectContaining({
      type: "turn_retry",
    }));
    expect(hub.send).toHaveBeenCalledTimes(1);
  });

  // [TOOL-FAILED-FALLBACK v1 · 2026-04-28] 工具失败 + 短开场句:必须再给一轮机会让模型给"基于常识/无法核实"的兜底答
  // 复现 V8 T08 case:live_news 工具失败,模型只回 "两个任务一起处理。" 9c → 用户拿到无意义短答
  it("does not retry when a tool failed and the assistant only produced a short throat-clearing lead-in", async () => {
    engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    hub.send = vi.fn(() => new Promise(() => {}));

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    const prompt = "【T08】给今天科技/AI 领域 2 条重要新闻,每条含发生日期、来源链接、为什么重要。";
    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: prompt }),
    }, connections[0].client);

    subscribed({
      type: "tool_execution_start",
      toolCallId: "call_news",
      toolName: "live_news",
      args: { query: "今日科技 AI 新闻" },
    }, "/sessions/current.jsonl");
    subscribed({
      type: "tool_execution_end",
      toolCallId: "call_news",
      toolName: "live_news",
      args: { query: "今日科技 AI 新闻" },
      result: { error: "fetch failed" },
      isError: true,
    }, "/sessions/current.jsonl");
    subscribed({ type: "turn_end" }, "/sessions/current.jsonl");

    subscribed({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "两个任务一起处理。",
      },
    }, "/sessions/current.jsonl");
    subscribed({ type: "turn_end" }, "/sessions/current.jsonl");

    await Promise.resolve();

    expect(clients[0].sent).not.toContainEqual(expect.objectContaining({
      type: "turn_retry",
    }));
    expect(hub.send).toHaveBeenCalledTimes(1);
  });

  // 同源 case:工具调用成功但模型只回 "好的" 这种 < 30c 短句也兜底
  it("does not retry when a tool failed and the assistant produced a sub-30-char generic answer", async () => {
    engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    hub.send = vi.fn(() => new Promise(() => {}));

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    const prompt = "今日金价多少?";
    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: prompt }),
    }, connections[0].client);

    subscribed({
      type: "tool_execution_start",
      toolCallId: "call_stock",
      toolName: "stock_market",
      args: { query: "今日金价" },
    }, "/sessions/current.jsonl");
    subscribed({
      type: "tool_execution_end",
      toolCallId: "call_stock",
      toolName: "stock_market",
      args: { query: "今日金价" },
      result: { error: "rate limit" },
      isError: true,
    }, "/sessions/current.jsonl");
    subscribed({ type: "turn_end" }, "/sessions/current.jsonl");

    subscribed({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "好的。",
      },
    }, "/sessions/current.jsonl");
    subscribed({ type: "turn_end" }, "/sessions/current.jsonl");

    await Promise.resolve();

    expect(clients[0].sent).not.toContainEqual(expect.objectContaining({
      type: "turn_retry",
    }));
  });

  // [TOOL-FAILED-FALLBACK v1.1 · 2026-04-28] 0c case (V8 v7 T08):工具失败 + 模型 0 文本
  it("does not retry when a tool failed and the assistant produced ZERO text (T08 case)", async () => {
    engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    hub.send = vi.fn(() => new Promise(() => {}));

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    const prompt = "【T08】今日科技 AI 新闻 2 条";
    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: prompt }),
    }, connections[0].client);

    subscribed({
      type: "tool_execution_start",
      toolCallId: "call_news",
      toolName: "live_news",
      args: { query: "今日科技 AI" },
    }, "/sessions/current.jsonl");
    subscribed({
      type: "tool_execution_end",
      toolCallId: "call_news",
      toolName: "live_news",
      args: { query: "今日科技 AI" },
      result: { error: "fetch failed" },
      isError: true,
    }, "/sessions/current.jsonl");
    subscribed({ type: "turn_end" }, "/sessions/current.jsonl");
    // 模型产 0 文本 → 直接 turn_end 第二次(deferred 后)
    subscribed({ type: "turn_end" }, "/sessions/current.jsonl");

    await Promise.resolve();

    expect(clients[0].sent).not.toContainEqual(expect.objectContaining({
      type: "turn_retry",
    }));
    expect(hub.send).toHaveBeenCalledTimes(1);
  });

  // 反向 case:工具成功 + 短答应该 NOT 触发 fallback (避免误伤)
  it("does NOT trigger tool_failed_fallback when the tool succeeded with a short answer", async () => {
    engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    hub.send = vi.fn(() => new Promise(() => {}));

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "今天上海天气?" }),
    }, connections[0].client);

    subscribed({
      type: "tool_execution_start",
      toolCallId: "call_w",
      toolName: "weather",
      args: { city: "shanghai" },
    }, "/sessions/current.jsonl");
    subscribed({
      type: "tool_execution_end",
      toolCallId: "call_w",
      toolName: "weather",
      args: { city: "shanghai" },
      result: { output: "晴 22°C" },
      isError: false,
    }, "/sessions/current.jsonl");
    subscribed({ type: "turn_end" }, "/sessions/current.jsonl");

    subscribed({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "上海今天晴 22°C。",
      },
    }, "/sessions/current.jsonl");
    subscribed({ type: "turn_end" }, "/sessions/current.jsonl");

    await Promise.resolve();

    const retryEvents = clients[0].sent.filter((e) => e.type === "turn_retry" && e.reason === "tool_failed_fallback");
    expect(retryEvents).toHaveLength(0);
  });

  // 2026-06-10 产品决策反转(用户实测报障:"有授权卡片但最后没有反馈",issue #72 第三类的 GUI 变体):
  // 工具执行成功而模型不给收尾文本时,turn 不再静默关闭 —— 输出一行基于真实 tool_end 计数的
  // 事实反馈(buildToolCompletionSummary,trustedFallback)。仍不允许编造模型内容。
  it("closes a successful tool turn with a factual tool-completion line when the model never sends final text", async () => {
    vi.useFakeTimers();
    try {
      engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
      engine.resolveModelOverrides = vi.fn((model) => model);
      engine.abortSessionByPath = vi.fn(async () => true);
      hub.send = vi.fn(() => new Promise(() => {}));

      const res = await app.request("/ws");
      expect(res.status).toBe(200);

      connections[0].handlers.onMessage({
        data: JSON.stringify({ type: "prompt", text: "把当前目录下所有 Excel 移到表格文件夹" }),
      }, connections[0].client);

      subscribed({
        type: "tool_execution_start",
        toolCallId: "call_move",
        toolName: "bash",
        args: { command: "mkdir -p 表格 && mv *.xlsx 表格/" },
      }, "/sessions/current.jsonl");
      subscribed({
        type: "tool_execution_end",
        toolCallId: "call_move",
        toolName: "bash",
        args: { command: "mkdir -p 表格 && mv *.xlsx 表格/" },
        result: { content: [{ type: "text", text: "moved\n" }] },
        isError: false,
      }, "/sessions/current.jsonl");

      await vi.advanceTimersByTimeAsync(8000);

      const visibleText = clients[0].sent
        .filter((evt) => evt.type === "text_delta")
        .map((evt) => evt.delta)
        .join("");
      // 事实行:真实 tool_end 证据摘要,不是模型口吻的编造内容。
      expect(visibleText).toContain("根据本轮已执行操作返回的可见结果");
      expect(visibleText).toContain("bash");
      expect(visibleText).toContain("mkdir -p 表格");
      expect(visibleText).toContain("moved");
      expect(clients[0].sent).toContainEqual(expect.objectContaining({ type: "turn_end" }));
      expect(clients[0].sent).toContainEqual(expect.objectContaining({ type: "status", isStreaming: false }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows realtime search evidence when web tools succeed but the model ends with thinking only", async () => {
    vi.useFakeTimers();
    try {
      engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
      engine.resolveModelOverrides = vi.fn((model) => model);
      engine.abortSessionByPath = vi.fn(async () => true);
      hub.send = vi.fn(() => new Promise(() => {}));

      const res = await app.request("/ws");
      expect(res.status).toBe(200);

      connections[0].handlers.onMessage({
        data: JSON.stringify({ type: "prompt", text: "昨晚世界杯赛程结束了吗？比赛结果如何" }),
      }, connections[0].client);

      subscribed({
        type: "tool_execution_start",
        toolCallId: "call_search_worldcup",
        toolName: "web_search",
        args: { query: "2026 世界杯 6月12日 比赛结果" },
      }, "/sessions/current.jsonl");
      subscribed({
        type: "tool_execution_end",
        toolCallId: "call_search_worldcup",
        toolName: "web_search",
        args: { query: "2026 世界杯 6月12日 比赛结果" },
        result: {
          content: [
            { type: "text", text: "Mexico beat South Africa 2-0; South Korea beat Czechia 2-1." },
          ],
          details: {
            provider: "web",
            summary: "Mexico beat South Africa 2-0; South Korea beat Czechia 2-1.",
          },
        },
        isError: false,
      }, "/sessions/current.jsonl");
      subscribed({
        type: "tool_execution_start",
        toolCallId: "call_fetch_worldcup",
        toolName: "web_fetch",
        args: { url: "https://example.test/world-cup-results" },
      }, "/sessions/current.jsonl");
      subscribed({
        type: "tool_execution_end",
        toolCallId: "call_fetch_worldcup",
        toolName: "web_fetch",
        args: { url: "https://example.test/world-cup-results" },
        result: {
          content: [
            { type: "text", text: "Canada drew Bosnia and Herzegovina 1-1 on June 12." },
          ],
        },
        isError: false,
      }, "/sessions/current.jsonl");
      subscribed({
        type: "message_update",
        assistantMessageEvent: {
          type: "thinking_delta",
          delta: "我已经查到 ESPN 页面,还要再核对赛事网站。",
        },
      }, "/sessions/current.jsonl");
      subscribed({ type: "turn_end" }, "/sessions/current.jsonl");

      expect(clients[0].sent.filter((evt) => evt.type === "turn_end")).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(8000);

      const visibleText = clients[0].sent
        .filter((evt) => evt.type === "text_delta")
        .map((evt) => evt.delta)
        .join("");

      expect(visibleText).toContain("根据本轮已执行工具返回的证据");
      expect(visibleText).toContain("网页搜索");
      expect(visibleText).toContain("Mexico beat South Africa 2-0");
      expect(visibleText).toContain("网页抓取");
      expect(visibleText).toContain("Canada drew Bosnia and Herzegovina 1-1");
      expect(visibleText).not.toContain("模型这次只返回了思考过程");
      expect(clients[0].sent).toContainEqual(expect.objectContaining({
        type: "turn_end",
        sessionPath: "/sessions/current.jsonl",
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes a tool authorization turn when no final event arrives after confirmation flow", async () => {
    vi.useFakeTimers();
    try {
      engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
      engine.resolveModelOverrides = vi.fn((model) => model);
      engine.abortSessionByPath = vi.fn(async () => true);
      hub.send = vi.fn(() => new Promise(() => {}));

      const res = await app.request("/ws");
      expect(res.status).toBe(200);

      connections[0].handlers.onMessage({
        data: JSON.stringify({ type: "prompt", text: "删除当前目录下 delete-me.txt，保留 keep.txt" }),
      }, connections[0].client);

      subscribed({
        type: "tool_authorization",
        confirmId: "confirm-delete",
        command: "rm /tmp/lynn-delete-fileops/delete-me.txt",
        reason: "删除文件需要确认",
        description: "删除文件或目录",
        category: "delete_files",
        identifier: "rm",
      }, "/sessions/current.jsonl");

      await vi.advanceTimersByTimeAsync(45_000);

      const visibleText = clients[0].sent
        .filter((evt) => evt.type === "text_delta")
        .map((evt) => evt.delta)
        .join("");
      expect(visibleText).toContain("模型这次没有返回可见内容");
      expect(clients[0].sent).toContainEqual(expect.objectContaining({ type: "turn_end" }));
      expect(clients[0].sent).toContainEqual(expect.objectContaining({ type: "status", isStreaming: false }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers a persisted final answer after tool authorization when no stream deltas arrive", async () => {
    vi.useFakeTimers();
    try {
      engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
      engine.resolveModelOverrides = vi.fn((model) => model);
      engine.abortSessionByPath = vi.fn(async () => true);
      hub.send = vi.fn(() => new Promise(() => {}));
      engine.getSessionByPath = vi.fn(() => ({
        messages: [
          { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "rm delete-me.txt" } }] },
          { role: "assistant", content: [{ type: "text", text: "当前目录现在只剩：keep.txt。delete-me.txt 已删除。" }] },
        ],
      }));

      const res = await app.request("/ws");
      expect(res.status).toBe(200);

      connections[0].handlers.onMessage({
        data: JSON.stringify({ type: "prompt", text: "删除当前目录下 delete-me.txt，保留 keep.txt" }),
      }, connections[0].client);

      subscribed({
        type: "tool_authorization",
        confirmId: "confirm-delete",
        command: "rm /tmp/lynn-delete-fileops/delete-me.txt",
        reason: "删除文件需要确认",
        description: "删除文件或目录",
        category: "delete_files",
        identifier: "rm",
      }, "/sessions/current.jsonl");

      await vi.advanceTimersByTimeAsync(1000);

      const visibleText = clients[0].sent
        .filter((evt) => evt.type === "text_delta")
        .map((evt) => evt.delta)
        .join("");
      expect(visibleText).toContain("delete-me.txt 已删除");
      expect(clients[0].sent).toContainEqual(expect.objectContaining({ type: "turn_end" }));
      expect(clients[0].sent).toContainEqual(expect.objectContaining({ type: "status", isStreaming: false }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not recover a failed probe into an authorized Downloads zip delete command", async () => {
    const recoveredExecute = vi.fn(async () => ({
      content: [{ type: "text", text: "下载文件夹中没有 zip 文件。\n" }],
    }));
    engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    engine.buildTools = vi.fn(() => ({
      tools: [{ name: "bash", execute: recoveredExecute }],
      customTools: [],
    }));
    engine.getSessionByPath = vi.fn(() => ({
      sessionManager: { getCwd: () => "/tmp/lynn-delete-zip-test" },
      messages: [],
    }));
    hub.send = vi.fn(() => new Promise(() => {}));

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "请把下载文件夹的所有后缀是zip 的文件都删除" }),
    }, connections[0].client);

    subscribed({
      type: "tool_execution_start",
      toolCallId: "call_bad_find",
      toolName: "bash",
      args: { command: "find" },
    }, "/sessions/current.jsonl");
    subscribed({
      type: "tool_execution_end",
      toolCallId: "call_bad_find",
      toolName: "bash",
      args: { command: "find" },
      result: { content: [{ type: "text", text: "usage: find [-H | -L | -P] path-list predicate-list" }] },
      isError: true,
    }, "/sessions/current.jsonl");

    await Promise.resolve();
    await Promise.resolve();

    expect(recoveredExecute).not.toHaveBeenCalled();
    expect(clients[0].sent).toContainEqual(expect.objectContaining({
      type: "tool_start",
      name: "bash",
      args: expect.objectContaining({ command: "find" }),
    }));
    expect(clients[0].sent).not.toContainEqual(expect.objectContaining({
      type: "tool_start",
      name: "bash",
      args: expect.objectContaining({ command: expect.stringContaining("rm -f") }),
    }));
  });

  it.each([
    [
      "Qwen tool-code",
      "</think>\n\n<|tool_code_begin|>bash\n\n<|tool_code_end|>",
      /<\/?think|tool_code_begin|tool_code_end|你刚才把工具调用写成了普通文本/,
    ],
    [
      "file-tool XML",
      "<find_files>\n*.zzzzzztest\n\n/Users/lynn/Downloads\n</find_files>",
      /<\/?find_files|你刚才把工具调用写成了普通文本/,
    ],
    [
      "bare bash JSON args",
      'bash\n\n{“cmd”: “find /Users/lynn/Downloads -type f -name "*zzzzzztest" 2>/dev/null”}',
      /(?:^|\n)\s*bash\s*(?:\n|$)|[“"]cmd[”"]|你刚才把工具调用写成了普通文本/,
    ],
  ])("suppresses %s pseudo markup for a Downloads delete task without recovery", async (_label, delta, forbiddenRe) => {
    const recoveredExecute = vi.fn(async () => ({
      content: [{ type: "text", text: "下载文件夹中没有 zzzzzztest 文件。\n" }],
    }));
    engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    engine.steerSession = vi.fn(() => true);
    engine.buildTools = vi.fn(() => ({
      tools: [{ name: "bash", execute: recoveredExecute }],
      customTools: [],
    }));
    engine.getSessionByPath = vi.fn(() => ({
      sessionManager: { getCwd: () => "/tmp/lynn-delete-qwen-test" },
      messages: [],
    }));
    hub.send = vi.fn(() => new Promise(() => {}));

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "请把下载文件夹的所有后缀是zzzzzztest的文件都删除" }),
    }, connections[0].client);

    subscribed({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta,
      },
    }, "/sessions/current.jsonl");
    subscribed({ type: "turn_end" }, "/sessions/current.jsonl");

    await Promise.resolve();

    expect(recoveredExecute).not.toHaveBeenCalled();
    expect(engine.steerSession).not.toHaveBeenCalled();

    const visibleText = clients[0].sent
      .filter((evt) => evt.type === "text_delta")
      .map((evt) => evt.delta)
      .join("");
    expect(visibleText).not.toMatch(forbiddenRe);
  });

  it("emits a persisted assistant reply when hub.send completes without stream deltas", async () => {
    engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    hub.send = vi.fn(async () => {});
    engine.getSessionByPath = vi.fn(() => ({
      messages: [
        { role: "user", content: [{ type: "text", text: "删除当前目录下 delete-me.txt，保留 keep.txt" }] },
        { role: "assistant", content: [{ type: "text", text: "已完成：delete-me.txt 已删除，keep.txt 已保留。" }] },
      ],
    }));

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "删除当前目录下 delete-me.txt，保留 keep.txt" }),
    }, connections[0].client);

    await vi.waitFor(() => {
      const visibleText = clients[0].sent
        .filter((evt) => evt.type === "text_delta")
        .map((evt) => evt.delta)
        .join("");
      expect(visibleText).toContain("delete-me.txt 已删除");
    });
    expect(clients[0].sent).toContainEqual(expect.objectContaining({ type: "turn_end" }));
    expect(clients[0].sent).toContainEqual(expect.objectContaining({ type: "status", isStreaming: false }));
  });

  it("closes a returned pseudo-tool-only turn without leaking generic fallback text", async () => {
    vi.useFakeTimers();
    try {
      engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
      engine.resolveModelOverrides = vi.fn((model) => model);
      hub.send = vi.fn(async () => {});
      engine.getSessionByPath = vi.fn(() => ({
        messages: [
          { role: "assistant", content: [{ type: "text", text: "<tool_call>bash\nrm delete-me.txt && ls\n" }] },
        ],
      }));

      const res = await app.request("/ws");
      expect(res.status).toBe(200);

      connections[0].handlers.onMessage({
        data: JSON.stringify({ type: "prompt", text: "删除当前目录下 delete-me.txt，保留 keep.txt" }),
      }, connections[0].client);

      await vi.waitFor(() => expect(hub.send).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(3000);

      const visibleText = clients[0].sent
        .filter((evt) => evt.type === "text_delta")
        .map((evt) => evt.delta)
        .join("");
      expect(visibleText).not.toContain("本轮模型没有生成可见答案");
      expect(visibleText).not.toContain("空转");
      expect(visibleText).toContain("rm delete-me.txt");
      expect(clients[0].sent).toContainEqual(expect.objectContaining({ type: "turn_end" }));
      expect(clients[0].sent).toContainEqual(expect.objectContaining({ type: "status", isStreaming: false }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("rolls tool finalization after partial text and closes if the model stops", async () => {
    vi.useFakeTimers();
    try {
      engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
      engine.resolveModelOverrides = vi.fn((model) => model);
      engine.abortSessionByPath = vi.fn(async () => true);
      hub.send = vi.fn(() => new Promise(() => {}));

      const res = await app.request("/ws");
      expect(res.status).toBe(200);

      connections[0].handlers.onMessage({
        data: JSON.stringify({ type: "prompt", text: "把当前目录下所有 Excel 移到表格文件夹" }),
      }, connections[0].client);

      subscribed({
        type: "tool_execution_start",
        toolCallId: "call_move",
        toolName: "bash",
        args: { command: "mkdir -p 表格 && mv *.xlsx 表格/" },
      }, "/sessions/current.jsonl");
      subscribed({
        type: "tool_execution_end",
        toolCallId: "call_move",
        toolName: "bash",
        args: { command: "mkdir -p 表格 && mv *.xlsx 表格/" },
        result: { content: [{ type: "text", text: "moved\n" }] },
        isError: false,
      }, "/sessions/current.jsonl");
      subscribed({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "已完成，" },
      }, "/sessions/current.jsonl");

      await vi.advanceTimersByTimeAsync(7999);
      expect(clients[0].sent.filter((evt) => evt.type === "turn_end")).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(2);
      expect(clients[0].sent).toContainEqual(expect.objectContaining({ type: "turn_end" }));
      expect(clients[0].sent).toContainEqual(expect.objectContaining({ type: "status", isStreaming: false }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("measures tool finalization grace from the latest overlapping tool activity", async () => {
    vi.useFakeTimers();
    try {
      engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
      engine.resolveModelOverrides = vi.fn((model) => model);
      engine.abortSessionByPath = vi.fn(async () => true);
      hub.send = vi.fn(() => new Promise(() => {}));

      const res = await app.request("/ws");
      expect(res.status).toBe(200);

      connections[0].handlers.onMessage({
        data: JSON.stringify({ type: "prompt", text: "先查资料再整理成表格" }),
      }, connections[0].client);

      subscribed({
        type: "tool_execution_start",
        toolCallId: "search-1",
        toolName: "web_search",
        args: { query: "first source" },
      }, "/sessions/current.jsonl");
      subscribed({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "我先整理已拿到的信息。" },
      }, "/sessions/current.jsonl");
      subscribed({ type: "turn_end" }, "/sessions/current.jsonl");

      await vi.advanceTimersByTimeAsync(4000);
      subscribed({
        type: "tool_execution_start",
        toolCallId: "fetch-2",
        toolName: "web_fetch",
        args: { url: "https://example.com/slow" },
      }, "/sessions/current.jsonl");

      await vi.advanceTimersByTimeAsync(4001);
      expect(engine.abortSessionByPath).not.toHaveBeenCalled();
      expect(clients[0].sent.filter((evt) => evt.type === "turn_end")).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(8000);
      expect(engine.abortSessionByPath).toHaveBeenCalledWith("/sessions/current.jsonl");
      expect(clients[0].sent).toContainEqual(expect.objectContaining({ type: "turn_end" }));
      expect(clients[0].sent).toContainEqual(expect.objectContaining({ type: "status", isStreaming: false }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not wait for hard timeout when a tool_end is missing but visible answer arrived", async () => {
    vi.useFakeTimers();
    try {
      engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
      engine.resolveModelOverrides = vi.fn((model) => model);
      engine.abortSessionByPath = vi.fn(async () => true);
      hub.send = vi.fn(() => new Promise(() => {}));

      const res = await app.request("/ws");
      expect(res.status).toBe(200);

      await connections[0].handlers.onMessage({
        data: JSON.stringify({ type: "prompt", text: "明天深圳天气如何？" }),
      }, connections[0].client);

      subscribed({
        type: "tool_execution_start",
        toolCallId: "weather-1",
        toolName: "weather",
        args: { location: "深圳" },
      }, "/sessions/current.jsonl");
      subscribed({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "明天深圳有零星小雨。" },
      }, "/sessions/current.jsonl");
      subscribed({ type: "turn_end" }, "/sessions/current.jsonl");

      await vi.advanceTimersByTimeAsync(7999);
      expect(clients[0].sent.filter((evt) => evt.type === "turn_end")).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(2);
      expect(engine.abortSessionByPath).toHaveBeenCalledWith("/sessions/current.jsonl");
      expect(clients[0].sent).toContainEqual(expect.objectContaining({ type: "turn_end" }));
      expect(clients[0].sent).toContainEqual(expect.objectContaining({ type: "status", isStreaming: false }));
      const visibleText = clients[0].sent
        .filter((evt) => evt.type === "text_delta")
        .map((evt) => evt.delta)
        .join("");
      expect(visibleText).toContain("明天深圳有零星小雨");
      expect(visibleText).not.toContain("本轮模型没有生成可见答案");
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears pending edit snapshots when a turn is force-closed", async () => {
    vi.useFakeTimers();
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "lynn-edit-pending-"));
    const filePath = path.join(tmpDir, "sample.txt");
    try {
      await fsPromises.writeFile(filePath, "before\n", "utf8");
      engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
      engine.resolveModelOverrides = vi.fn((model) => model);
      engine.abortSessionByPath = vi.fn(async () => true);
      engine.getSessionByPath = vi.fn(() => ({
        sessionManager: { getCwd: () => tmpDir },
        messages: [],
      }));
      hub.send = vi.fn(() => new Promise(() => {}));

      const res = await app.request("/ws");
      expect(res.status).toBe(200);

      connections[0].handlers.onMessage({
        data: JSON.stringify({ type: "prompt", text: "编辑 sample.txt" }),
      }, connections[0].client);

      subscribed({
        type: "tool_execution_start",
        toolCallId: "edit-1",
        toolName: "edit",
        args: { file_path: filePath },
      }, "/sessions/current.jsonl");

      expect(editRollbackStore.pendingCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(editRollbackStore.pendingCount()).toBe(0);
      expect(clients[0].sent).toContainEqual(expect.objectContaining({ type: "turn_end" }));
    } finally {
      vi.useRealTimers();
      await fsPromises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not create an internal retry after an empty model turn, so the next prompt can proceed", async () => {
    engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    engine.abortSessionByPath = vi.fn(async () => true);
    hub.send = vi.fn(() => Promise.resolve());

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    // T05 prompt
    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "T05 在上海做晚餐" }),
    }, connections[0].client);

    await vi.waitFor(() => expect(hub.send).toHaveBeenCalledTimes(1));

    // T05 模型给 turn_end 但没有任何文本 → 不触发内部重试
    subscribed({ type: "turn_end" }, "/sessions/current.jsonl");
    await Promise.resolve();
    await Promise.resolve();

    expect(hub.send).toHaveBeenCalledTimes(1);
    expect(clients[0].sent).not.toContainEqual(expect.objectContaining({
      type: "turn_retry",
    }));

    // T06 进来发新 prompt
    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "T06 推荐电影" }),
    }, connections[0].client);

    await vi.waitFor(() => expect(hub.send).toHaveBeenCalledTimes(2), { timeout: 1000 });
    expect(engine.abortSessionByPath).not.toHaveBeenCalled();
    expect(clients[0].sent).not.toContainEqual(expect.objectContaining({
      type: "error",
      message: expect.stringContaining("还在说话"),
    }));
    expect(clients[0].sent).not.toContainEqual(expect.objectContaining({
      type: "error",
      message: expect.stringContaining("still"),
    }));
    expect(clients[0].sent).not.toContainEqual(expect.objectContaining({
      type: "text_delta",
      delta: expect.stringMatching(/没有生成可用回复|空转/),
    }));
    expect(hub.send.mock.calls[1]?.[0]).toContain("T06 推荐电影");
  });

  it("closes the active stream before accepting a second prompt, preventing stale replies", async () => {
    engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    engine.abortSessionByPath = vi.fn(async () => true);
    engine.isSessionStreaming = vi.fn(() => false);
    hub.send = vi.fn(() => new Promise(() => {}));

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "请写一段不少于 300 字的广州旅行计划" }),
    }, connections[0].client);
    await vi.waitFor(() => expect(hub.send).toHaveBeenCalledTimes(1));
    engine.isSessionStreaming.mockReturnValue(true);

    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "周日广州会下雨吗？" }),
    }, connections[0].client);
    await vi.waitFor(() => expect(hub.send).toHaveBeenCalledTimes(2));

    expect(engine.abortSessionByPath).toHaveBeenCalledWith("/sessions/current.jsonl");
    expect(clients[0].sent).toContainEqual(expect.objectContaining({
      type: "turn_end",
      sessionPath: "/sessions/current.jsonl",
    }));
    expect(clients[0].sent).toContainEqual(expect.objectContaining({
      type: "status",
      isStreaming: false,
      sessionPath: "/sessions/current.jsonl",
    }));
    expect(clients[0].sent).not.toContainEqual(expect.objectContaining({
      type: "error",
      message: expect.stringContaining("还在说话"),
    }));
    expect(clients[0].sent).not.toContainEqual(expect.objectContaining({
      type: "error",
      message: expect.stringContaining("still"),
    }));
    expect(hub.send.mock.calls[1]?.[0]).toContain("周日广州会下雨吗？");
  });

  it("does not abort a silent Brain turn after the old 25s grace window", async () => {
    vi.useFakeTimers();
    let rejectSend;
    try {
      engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
      engine.resolveModelOverrides = vi.fn((model) => model);
      engine.abortSessionByPath = vi.fn(async () => true);
      hub.send = vi.fn(() => new Promise((resolve, reject) => {
        rejectSend = reject;
      }));

      const res = await app.request("/ws");
      expect(res.status).toBe(200);

      connections[0].handlers.onMessage({
        data: JSON.stringify({ type: "prompt", text: "请执行终端命令 echo hi" }),
      }, connections[0].client);

      await vi.advanceTimersByTimeAsync(24_999);
      expect(engine.abortSessionByPath).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(engine.abortSessionByPath).not.toHaveBeenCalled();

      rejectSend?.(new Error("aborted"));
      await vi.runOnlyPendingTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes aborted thinking-only turns with visible fallback text", async () => {
    let rejectSend;
    engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    hub.send = vi.fn(() => new Promise((resolve, reject) => {
      rejectSend = reject;
    }));

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "今晚世界杯有几场比赛？" }),
    }, connections[0].client);

    await vi.waitFor(() => expect(hub.send).toHaveBeenCalled());
    subscribed({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        delta: "我先检索赛程，然后组织答案。",
      },
    }, "/sessions/current.jsonl");

    rejectSend?.(new Error("aborted"));
    await waitForAsyncHandlers();

    const visibleText = clients[0].sent
      .filter((evt) => evt.type === "text_delta")
      .map((evt) => evt.delta)
      .join("");
    expect(visibleText).toContain("模型请求中断前只返回了思考过程");
    expect(clients[0].sent).toContainEqual(expect.objectContaining({
      type: "turn_end",
      sessionPath: "/sessions/current.jsonl",
    }));
    expect(clients[0].sent).toContainEqual(expect.objectContaining({
      type: "status",
      isStreaming: false,
      sessionPath: "/sessions/current.jsonl",
    }));
  });

  it("uses completed tool evidence instead of thinking-only copy when an aborted turn had tools", async () => {
    let rejectSend;
    engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    hub.send = vi.fn(() => new Promise((resolve, reject) => {
      rejectSend = reject;
    }));

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "今晚世界杯有几场比赛？" }),
    }, connections[0].client);

    await vi.waitFor(() => expect(hub.send).toHaveBeenCalled());
    subscribed({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        delta: "我先检索赛程，然后组织答案。",
      },
    }, "/sessions/current.jsonl");
    subscribed({
      type: "tool_execution_start",
      toolCallId: "call_sports",
      toolName: "sports_score",
      args: { query: "今晚世界杯有几场比赛？" },
    }, "/sessions/current.jsonl");
    subscribed({
      type: "tool_execution_end",
      toolCallId: "call_sports",
      toolName: "sports_score",
      args: { query: "今晚世界杯有几场比赛？" },
      result: { content: [{ type: "text", text: "2026-06-21 20:00 Brazil vs Japan; 2026-06-22 02:00 USA vs Spain." }] },
      isError: false,
    }, "/sessions/current.jsonl");

    rejectSend?.(new Error("aborted"));
    await waitForAsyncHandlers();

    const visibleText = clients[0].sent
      .filter((evt) => evt.type === "text_delta")
      .map((evt) => evt.delta)
      .join("");
    expect(visibleText).toContain("Brazil vs Japan");
    expect(visibleText).toContain("USA vs Spain");
    expect(visibleText).not.toContain("模型请求中断前只返回了思考过程");
    expect(clients[0].sent).toContainEqual(expect.objectContaining({
      type: "turn_end",
      sessionPath: "/sessions/current.jsonl",
    }));
  });

  it("hard-aborts a Brain turn that streams thinking but never visible text", async () => {
    vi.useFakeTimers();
    try {
      engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
      engine.resolveModelOverrides = vi.fn((model) => model);
      engine.abortSessionByPath = vi.fn(async () => true);
      hub.send = vi.fn(() => new Promise(() => {}));

      const res = await app.request("/ws");
      expect(res.status).toBe(200);

      connections[0].handlers.onMessage({
        data: JSON.stringify({ type: "prompt", text: "详细推理一道复杂逻辑题" }),
      }, connections[0].client);

      await Promise.resolve();
      expect(hub.send).toHaveBeenCalled();

      subscribed({
        type: "message_update",
        assistantMessageEvent: {
          type: "thinking_delta",
          delta: "我需要仔细推理，但一直没有形成可见答案。",
        },
      }, "/sessions/current.jsonl");

      await vi.advanceTimersByTimeAsync(119_999);
      expect(engine.abortSessionByPath).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);

      expect(engine.abortSessionByPath).toHaveBeenCalledWith("/sessions/current.jsonl");
      const visibleText = clients[0].sent
        .filter((evt) => evt.type === "text_delta")
        .map((evt) => evt.delta)
        .join("");
      expect(visibleText).not.toContain("长时间没有生成可见答案");
      expect(visibleText).not.toContain("空转");
      expect(clients[0].sent).toContainEqual(expect.objectContaining({
        type: "turn_end",
        sessionPath: "/sessions/current.jsonl",
      }));
      expect(clients[0].sent).toContainEqual(expect.objectContaining({
        type: "status",
        isStreaming: false,
        sessionPath: "/sessions/current.jsonl",
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  // 2026-06-10 产品决策反转(同上):静默关闭 → 事实反馈行。
  it("closes with a factual tool-completion line when tools succeeded but the model never finalizes", async () => {
    vi.useFakeTimers();
    try {
      engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
      engine.resolveModelOverrides = vi.fn((model) => model);
      engine.abortSessionByPath = vi.fn(async () => true);
      hub.send = vi.fn(() => new Promise(() => {}));

      const res = await app.request("/ws");
      expect(res.status).toBe(200);

      connections[0].handlers.onMessage({
        data: JSON.stringify({ type: "prompt", text: "把桌面的图片整理到一个新的文件夹里" }),
      }, connections[0].client);

      await Promise.resolve();
      expect(hub.send).toHaveBeenCalled();

      subscribed({
        type: "tool_execution_start",
        toolCallId: "call_move_images",
        toolName: "bash",
        args: { command: "mkdir -p /Users/lynn/Desktop/图片 && mv /Users/lynn/Desktop/*.png /Users/lynn/Desktop/图片/" },
      }, "/sessions/current.jsonl");
      subscribed({
        type: "tool_execution_end",
        toolCallId: "call_move_images",
        toolName: "bash",
        args: { command: "mkdir -p /Users/lynn/Desktop/图片 && mv /Users/lynn/Desktop/*.png /Users/lynn/Desktop/图片/" },
        result: {
          content: [
            { type: "text", text: "moved 3 image files" },
          ],
        },
        isError: false,
      }, "/sessions/current.jsonl");

      subscribed({ type: "turn_end" }, "/sessions/current.jsonl");

      expect(clients[0].sent.filter((evt) => evt.type === "turn_end")).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(7_999);
      expect(clients[0].sent.filter((evt) => evt.type === "turn_end")).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1);

      expect(engine.abortSessionByPath).toHaveBeenCalledWith("/sessions/current.jsonl");
      const visibleText = clients[0].sent
        .filter((evt) => evt.type === "text_delta")
        .map((evt) => evt.delta)
        .join("");
      // 事实行:真实 tool_end 证据摘要,不是模型口吻的编造内容。
      expect(visibleText).toContain("根据本轮已执行操作返回的可见结果");
      expect(visibleText).toContain("bash");
      expect(visibleText).toContain("moved 3 image files");
      expect(clients[0].sent).toContainEqual(expect.objectContaining({
        type: "turn_end",
        sessionPath: "/sessions/current.jsonl",
      }));
      expect(clients[0].sent).toContainEqual(expect.objectContaining({
        type: "status",
        isStreaming: false,
        sessionPath: "/sessions/current.jsonl",
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  // Deterministic realtime facts get a local evidence pass even for Brain V2,
  // so GUI turns can close from tool evidence if the writer times out.
  it("injects local deterministic realtime prefetch for brain weather turns", async () => {
    engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    let eventsBeforeModelCall = [];
    hub.send = vi.fn(async () => {
      eventsBeforeModelCall = [...clients[0].sent];
    });
    reportResearchMock.inferReportResearchKind.mockReturnValue("weather");
    reportResearchMock.buildReportResearchContext.mockResolvedValue("【系统已完成天气工具预取】\n深圳今日天气晴。");

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "今天深圳天气如何" }),
    }, connections[0].client);

    await vi.waitFor(() => expect(hub.send).toHaveBeenCalled());

    expect(eventsBeforeModelCall).toContainEqual(expect.objectContaining({
      type: "tool_start",
      name: "weather",
      sessionPath: "/sessions/current.jsonl",
    }));
    expect(eventsBeforeModelCall).toContainEqual(expect.objectContaining({
      type: "tool_end",
      name: "weather",
      success: true,
      sessionPath: "/sessions/current.jsonl",
    }));
    expect(reportResearchMock.buildReportResearchContext).toHaveBeenCalled();
  });

  it("closes simple market prefetch turns with a direct local answer before model tool chains", async () => {
    engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    hub.send = vi.fn(async () => {});
    reportResearchMock.inferReportResearchKind.mockReturnValue("market");
    reportResearchMock.buildReportResearchContext.mockResolvedValue([
      "【行情工具资料】",
      "黄金价格快照（via gold-api.com）",
      "查询：今日金价是多少？",
      "可核验到的黄金价格（2026-06-21）：",
      "- 国际现货黄金（XAU/USD） 907.29 元/克（约 4156.7 美元/盎司，USD/CNY 6.7890）",
    ].join("\n"));
    reportResearchMock.buildDirectResearchAnswer.mockReturnValue("根据刚刚检索到的 2026-06-21 黄金价格：\n- 国际现货黄金（XAU/USD） 907.29 元/克");

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "今日金价是多少？" }),
    }, connections[0].client);

    await vi.waitFor(() => expect(clients[0].sent.some((evt) => evt.type === "turn_end")).toBe(true));

    expect(hub.send).not.toHaveBeenCalled();
    expect(clients[0].sent).toContainEqual(expect.objectContaining({
      type: "tool_start",
      name: "stock_market",
      sessionPath: "/sessions/current.jsonl",
    }));
    expect(clients[0].sent).toContainEqual(expect.objectContaining({
      type: "tool_end",
      name: "stock_market",
      success: true,
      sessionPath: "/sessions/current.jsonl",
    }));
    const visibleText = clients[0].sent
      .filter((evt) => evt.type === "text_delta")
      .map((evt) => evt.delta)
      .join("");
    expect(visibleText).toContain("907.29 元/克");
  });

  it("closes public-data prefetch turns with a bounded local summary", async () => {
    engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    hub.send = vi.fn(async () => {});
    reportResearchMock.inferReportResearchKind.mockReturnValue("public_data");
    reportResearchMock.buildReportResearchContext.mockResolvedValue("【研究资料】\n摘要: 每组 10-20 人，年费约 8万-20万元。");
    reportResearchMock.buildDirectResearchAnswer.mockReturnValue("公开资料里私董会的收费通常不透明。\n| 类型/机构 | 常见单组人数 | 常见收费口径 |\n| 专业私董会 | 10-20 人/组 | 8万-20万元/年 |");

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "中国主要私董会的人数和收费大概多少？" }),
    }, connections[0].client);

    await vi.waitFor(() => expect(clients[0].sent.some((evt) => evt.type === "turn_end")).toBe(true));

    expect(hub.send).not.toHaveBeenCalled();
    expect(clients[0].sent).toContainEqual(expect.objectContaining({
      type: "tool_start",
      name: "web_search",
      sessionPath: "/sessions/current.jsonl",
    }));
    const visibleText = clients[0].sent
      .filter((evt) => evt.type === "text_delta")
      .map((evt) => evt.delta)
      .join("");
    expect(visibleText).toContain("10-20 人/组");
  });

  it("closes sports table prefetch turns with a direct local answer before model tool chains", async () => {
    engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    hub.send = vi.fn(async () => {});
    reportResearchMock.inferReportResearchKind.mockReturnValue("sports");
    reportResearchMock.buildReportResearchContext.mockResolvedValue("【体育比分工具资料】\n体育查询结果 (ESPN scoreboard)\n匹配比赛: 4 场\n- 2026/06/22 00:00 Spain vs Saudi Arabia (Scheduled)");
    reportResearchMock.buildDirectResearchAnswer.mockReturnValue([
      "已匹配到的赛程（北京时间），共 4 场：",
      "",
      "| 时间（北京时间） | 对阵/比分 | 状态 |",
      "|---|---|---|",
      "| 2026/06/22 00:00 | Spain vs Saudi Arabia | Scheduled |",
    ].join("\n"));

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "查询今晚世界杯赛程，并最后用一个小表格输出" }),
    }, connections[0].client);

    await vi.waitFor(() => expect(clients[0].sent.some((evt) => evt.type === "turn_end")).toBe(true));

    expect(hub.send).not.toHaveBeenCalled();
    expect(clients[0].sent).toContainEqual(expect.objectContaining({
      type: "tool_start",
      name: "sports_score",
      sessionPath: "/sessions/current.jsonl",
    }));
    const visibleText = clients[0].sent
      .filter((evt) => evt.type === "text_delta")
      .map((evt) => evt.delta)
      .join("");
    expect(visibleText).toContain("| 时间（北京时间） | 对阵/比分 | 状态 |");
    expect(visibleText).toContain("Spain vs Saudi Arabia");
  });

  it("closes GUI sports tool-chain turns from ESPN evidence before generic search can override it", async () => {
    engine.currentModel = { id: "glm-5-turbo", provider: "glm", name: "GLM 5.0 Turbo" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    engine.abortSessionByPath = vi.fn(async () => true);
    reportResearchMock.inferReportResearchKind.mockReturnValue("");
    hub.send = vi.fn(() => new Promise(() => {}));

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "今晚世界杯几场比赛帮我查一下" }),
    }, connections[0].client);

    await vi.waitFor(() => expect(hub.send).toHaveBeenCalled());

    subscribed({
      type: "tool_execution_start",
      toolName: "sportsscore",
      args: { query: "今晚世界杯几场比赛帮我查一下" },
    }, "/sessions/current.jsonl");
    subscribed({
      type: "tool_execution_end",
      toolName: "sportsscore",
      args: { query: "今晚世界杯几场比赛帮我查一下" },
      result: {
        content: [{
          type: "text",
          text: [
            "体育查询结果 (ESPN scoreboard)",
            "provider: espn_scoreboard",
            "league: FIFA World Cup",
            "source: https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?limit=950&dates=20260625-20260626",
            "dateRange: 20260625-20260626",
            "时间口径: 北京时间",
            "查询口径: “今晚/今夜”按北京时间 2026-06-25 晚间至 2026-06-26 后续赛程处理；不是“昨晚”。",
            "matched: 6",
            "匹配比赛: 6 场",
            "",
            "- 2026/06/26 04:00 Curaçao vs Ivory Coast (Scheduled)",
            "- 2026/06/26 04:00 Ecuador vs Germany (Scheduled)",
            "- 2026/06/26 07:00 Japan vs Sweden (Scheduled)",
            "- 2026/06/26 07:00 Tunisia vs Netherlands (Scheduled)",
            "- 2026/06/26 10:00 Paraguay vs Australia (Scheduled)",
            "- 2026/06/26 10:00 Türkiye vs United States (Scheduled)",
          ].join("\n"),
        }],
        details: { provider: "espn_scoreboard" },
      },
    }, "/sessions/current.jsonl");

    await vi.waitFor(() => expect(clients[0].sent.some((evt) => evt.type === "turn_end")).toBe(true));

    expect(engine.abortSessionByPath).toHaveBeenCalledWith("/sessions/current.jsonl");
    const visibleText = clients[0].sent
      .filter((evt) => evt.type === "text_delta")
      .map((evt) => evt.delta)
      .join("");
    expect(visibleText).toContain("共 6 场");
    expect(visibleText).toContain("Curaçao vs Ivory Coast");
    expect(visibleText).toContain("Türkiye vs United States");
    expect(visibleText).not.toContain("2026/06/21");
    expect(visibleText).not.toContain("Netherlands 5-1 Sweden");
  });

  it("closes simple table template turns with a deterministic local answer", async () => {
    engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    hub.send = vi.fn(async () => {});
    reportResearchMock.inferReportResearchKind.mockReturnValue("");

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "给我一个三列表格：任务、优先级、风险" }),
    }, connections[0].client);

    await vi.waitFor(() => expect(clients[0].sent.some((evt) => evt.type === "turn_end")).toBe(true));

    expect(hub.send).not.toHaveBeenCalled();
    const visibleText = clients[0].sent
      .filter((evt) => evt.type === "text_delta")
      .map((evt) => evt.delta)
      .join("");
    expect(visibleText).toContain("| 任务 | 优先级 | 风险 |");
    expect(visibleText).toContain("| 明确需求范围 | 高 |");
  });

  it("closes simple sort-and-dedupe turns with a deterministic local answer", async () => {
    engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    hub.send = vi.fn(async () => {});
    reportResearchMock.inferReportResearchKind.mockReturnValue("");

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "把这个列表排序并去重：banana, apple, banana, pear" }),
    }, connections[0].client);

    await vi.waitFor(() => expect(clients[0].sent.some((evt) => evt.type === "turn_end")).toBe(true));

    expect(hub.send).not.toHaveBeenCalled();
    const visibleText = clients[0].sent
      .filter((evt) => evt.type === "text_delta")
      .map((evt) => evt.delta)
      .join("");
    expect(visibleText).toBe("apple, banana, pear");
  });

  it("closes a BYOK local prefetch turn with realtime evidence when the model returns no text", async () => {
    vi.useFakeTimers();
    try {
      engine.currentModel = { id: "deepseek-v4-flash", provider: "deepseek", name: "DeepSeek V4 Flash" };
      engine.resolveModelOverrides = vi.fn((model) => model);
      engine.abortSessionByPath = vi.fn(async () => true);
      reportResearchMock.inferReportResearchKind.mockReturnValue("sports");
      reportResearchMock.buildReportResearchContext.mockResolvedValue([
        "今晚（6月14日）小组赛还有4场:",
        "03:00 卡塔尔 vs 瑞士 B组",
        "06:00 巴西 vs 摩洛哥 D组",
        "09:00 海地 vs 苏格兰 E组",
      ].join("\n"));
      hub.send = vi.fn(async () => {
        subscribed({ type: "turn_end" }, "/sessions/current.jsonl");
      });

      const res = await app.request("/ws");
      expect(res.status).toBe(200);

      connections[0].handlers.onMessage({
        data: JSON.stringify({ type: "prompt", text: "今晚世界杯比赛几点开始" }),
      }, connections[0].client);

      await vi.waitFor(() => expect(hub.send).toHaveBeenCalled());
      expect(clients[0].sent).toContainEqual(expect.objectContaining({
        type: "tool_start",
        name: "sports_score",
      }));
      expect(clients[0].sent).toContainEqual(expect.objectContaining({
        type: "tool_end",
        name: "sports_score",
        success: true,
      }));
      expect(clients[0].sent.filter((evt) => evt.type === "turn_end")).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(8_000);

      const visibleText = clients[0].sent
        .filter((evt) => evt.type === "text_delta")
        .map((evt) => evt.delta)
        .join("");
      expect(visibleText).toContain("根据本轮已执行工具返回的证据");
      expect(visibleText).toContain("体育比分");
      expect(visibleText).toContain("卡塔尔 vs 瑞士");
      expect(clients[0].sent).toContainEqual(expect.objectContaining({ type: "turn_end" }));
      expect(clients[0].sent).toContainEqual(expect.objectContaining({ type: "status", isStreaming: false }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("disables tools for simple memory acknowledgement turns", async () => {
    engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    hub.send = vi.fn(async () => {});

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    connections[0].handlers.onMessage({
      data: JSON.stringify({
        type: "prompt",
        text: "请记住本轮回归测试项目代号：银杏-42。它不是密码、口令或密钥，只是普通项目标签。只回复“已记住”。",
      }),
    }, connections[0].client);

    await vi.waitFor(() => expect(hub.send).toHaveBeenCalled());
    const [effectivePrompt, opts] = hub.send.mock.calls[0];
    expect(effectivePrompt).not.toContain("不要读取或写入文件");
    expect(effectivePrompt).toContain("只回复“已记住”");
    expect(opts).toEqual(expect.objectContaining({
      sessionPath: "/sessions/current.jsonl",
      disableTools: true,
      turnInstruction: expect.stringContaining("不要读取或写入文件"),
    }));
  });

  it("suppresses pseudo tool text for Brain without client-side retry prompts", async () => {
    engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    engine.steerSession = vi.fn(() => true);
    hub.send = vi.fn(async () => {});
    reportResearchMock.inferReportResearchKind.mockReturnValue("weather");
    reportResearchMock.buildReportResearchContext.mockResolvedValue("【系统已完成天气工具预取】\n深圳明天小雨，18-22°C，建议带伞。");
    reportResearchMock.buildDirectResearchAnswer.mockReturnValue("");

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "明天深圳天气如何" }),
    }, connections[0].client);

    await vi.waitFor(() => expect(hub.send).toHaveBeenCalled());

    subscribed({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "<web_search>\n深圳天气\n</web_search>",
      },
    }, "/sessions/current.jsonl");
    subscribed({ type: "turn_end" }, "/sessions/current.jsonl");

    const visibleText = clients[0].sent
      .filter((evt) => evt.type === "text_delta")
      .map((evt) => evt.delta)
      .join("");
    expect(visibleText).not.toContain("<web_search>");
    expect(clients[0].sent).not.toContainEqual(expect.objectContaining({
      type: "turn_retry",
    }));
  });

  it("does not recover Brain pseudo weather skill reads through the real weather tool", async () => {
    engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    const weatherExecute = vi.fn(async () => ({
      content: [{ type: "text", text: "深圳明天小雨，22-27°C。建议带伞。" }],
      details: { provider: "test-weather" },
    }));
    engine.buildTools = vi.fn(() => ({
      tools: [{ name: "weather", execute: weatherExecute }],
      customTools: [],
    }));
    hub.send = vi.fn(async () => {});

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "用工具查深圳明天天气，回答温度、天气和一句出行建议。" }),
    }, connections[0].client);

    await vi.waitFor(() => expect(hub.send).toHaveBeenCalled());

    subscribed({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "<tool_call>\n<function=read>\n<parameter=file_path>/Users/lynn/.lynn/skills/weather/SKILL.md</parameter>\n</function>\n</tool_call>",
      },
    }, "/sessions/current.jsonl");
    subscribed({ type: "turn_end" }, "/sessions/current.jsonl");

    await Promise.resolve();
    expect(weatherExecute).not.toHaveBeenCalled();

    const visibleText = clients[0].sent
      .filter((evt) => evt.type === "text_delta")
      .map((evt) => evt.delta)
      .join("");
    expect(visibleText).not.toContain("<tool_call>");
    expect(clients[0].sent).not.toContainEqual(expect.objectContaining({
      type: "turn_retry",
    }));
  });

  it("does not recover Brain pseudo market searches through the real stock_market tool", async () => {
    engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    const stockExecute = vi.fn(async () => ({
      content: [{ type: "text", text: "AAPL：195.12 USD；TSLA：178.40 USD；时间：2026-05-08 13:00；来源：test-market。" }],
      details: { provider: "test-market" },
    }));
    engine.buildTools = vi.fn(() => ({
      tools: [{ name: "stock_market", execute: stockExecute }],
      customTools: [],
    }));
    hub.send = vi.fn(async () => {});

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "查最近可用的 AAPL 和 TSLA 行情，给时间戳和来源，并明确这不构成投资建议。" }),
    }, connections[0].client);

    await vi.waitFor(() => expect(hub.send).toHaveBeenCalled());

    subscribed({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "<tool_call>\n<function=web_search>\n<parameter=query>AAPL stock price today</parameter>\n</function>\n</tool_call>",
      },
    }, "/sessions/current.jsonl");
    subscribed({ type: "turn_end" }, "/sessions/current.jsonl");

    await Promise.resolve();
    expect(stockExecute).not.toHaveBeenCalled();
    const visibleText = clients[0].sent
      .filter((evt) => evt.type === "text_delta")
      .map((evt) => evt.delta)
      .join("");
    expect(clients[0].sent).not.toContainEqual(expect.objectContaining({
      type: "tool_start",
      name: "stock_market",
      sessionPath: "/sessions/current.jsonl",
    }));
    expect(visibleText).not.toContain("<tool_call>");
  });

  it("does not inject local prefetch for non-realtime brain turns", async () => {
    engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    let eventsBeforeModelCall = [];
    hub.send = vi.fn(async () => {
      eventsBeforeModelCall = [...clients[0].sent];
    });
    reportResearchMock.inferReportResearchKind.mockReturnValue("generic");
    reportResearchMock.buildReportResearchContext.mockResolvedValue("【系统已完成研究预取】");
    reportResearchMock.buildReportResearchContext.mockClear();

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "帮我写一个普通研究计划" }),
    }, connections[0].client);

    await vi.waitFor(() => expect(hub.send).toHaveBeenCalled());

    expect(eventsBeforeModelCall).not.toContainEqual(expect.objectContaining({ type: "tool_start" }));
    expect(reportResearchMock.buildReportResearchContext).not.toHaveBeenCalled();
  });

  // 保留对非 brain (BYOK) 路径的 prefetch 覆盖 —— 当前实现 chat.js:1338 仅 gate 在 isBrain,
  // 非 brain provider 仍走 prefetch。后续如果决定全 provider 都移除,这条改成 .skip 即可。
  it("still injects local prefetch as a tool stage for non-brain providers (BYOK path)", async () => {
    engine.currentModel = { id: "gpt-4o", provider: "openai", name: "GPT-4o" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    let eventsBeforeModelCall = [];
    hub.send = vi.fn(async () => {
      eventsBeforeModelCall = [...clients[0].sent];
    });
    reportResearchMock.inferReportResearchKind.mockReturnValue("weather");
    reportResearchMock.buildReportResearchContext.mockResolvedValue("【系统已完成天气工具预取】\n深圳今日天气晴。");

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "今天深圳天气如何" }),
    }, connections[0].client);

    await vi.waitFor(() => expect(hub.send).toHaveBeenCalled());

    expect(eventsBeforeModelCall).toContainEqual(expect.objectContaining({
      type: "tool_start",
      name: "weather",
      sessionPath: "/sessions/current.jsonl",
    }));
    expect(eventsBeforeModelCall).toContainEqual(expect.objectContaining({
      type: "tool_end",
      name: "weather",
      success: true,
      sessionPath: "/sessions/current.jsonl",
    }));
  });

  it("creates a session on the first prompt when currentSessionPath is empty", async () => {
    engine.currentSessionPath = "";
    engine.createSession = vi.fn(async () => ({
      sessionManager: { getSessionFile: () => "/sessions/new.jsonl" },
    }));
    reportResearchMock.inferReportResearchKind.mockReturnValue("market_weather_brief");
    reportResearchMock.buildReportResearchContext.mockResolvedValue("【系统已完成综合工具预取】");
    reportResearchMock.buildDirectResearchAnswer.mockReturnValue("数据快照\n- AAPL：$273.05");
    hub.send = vi.fn(async () => {});

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "请同时看一下今天 AAPL 最新价和上海天气" }),
    }, connections[0].client);

    await vi.waitFor(() => expect(engine.createSession).toHaveBeenCalled());

    expect(clients[0].sent).toContainEqual(expect.objectContaining({
      type: "tool_start",
      name: "market_weather_brief",
      sessionPath: "/sessions/new.jsonl",
    }));
    expect(clients[0].sent.some((evt) => evt.type === "text_delta"
      && evt.sessionPath === "/sessions/new.jsonl"
      && String(evt.delta || "").includes("AAPL"))).toBe(false);
  });

  it("suppresses hallucinated tool-progress XML that only flushes at turn end", async () => {
    engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    hub.send = vi.fn(() => new Promise(() => {}));

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "帮我查一下今天金价" }),
    }, connections[0].client);

    subscribed({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "正在核对资料。<lynn_tool_progress event=\"start\" name=\"web_search\"></lynn_tool_progress>今天金价偏强。",
      },
    }, "/sessions/current.jsonl");

    subscribed({ type: "turn_end" }, "/sessions/current.jsonl");

    expect(clients[0].sent).not.toContainEqual(expect.objectContaining({
      type: "tool_progress",
    }));

    const visibleText = clients[0].sent
      .filter((evt) => evt.type === "text_delta")
      .map((evt) => evt.delta)
      .join("");

    expect(visibleText).toContain("正在核对资料。");
    expect(visibleText).toContain("今天金价偏强。");
    expect(visibleText).not.toContain("<lynn_tool_progress");
  });

  it("does not abort a silent Brain turn after the old 25s prefetch grace window", async () => {
    vi.useFakeTimers();
    try {
      engine.currentModel = { id: "lynn-brain-router", provider: "brain", name: "默认模型" };
      engine.resolveModelOverrides = vi.fn((model) => model);
      engine.abortSessionByPath = vi.fn(async () => true);
      hub.send = vi.fn(() => new Promise(() => {}));
      reportResearchMock.inferReportResearchKind.mockReturnValue("weather");
      reportResearchMock.buildReportResearchContext.mockResolvedValue("【系统已完成天气工具预取】\n深圳今日天气晴。");

      const res = await app.request("/ws");
      expect(res.status).toBe(200);

      connections[0].handlers.onMessage({
        data: JSON.stringify({ type: "prompt", text: "今天深圳天气如何" }),
      }, connections[0].client);

      await vi.waitFor(() => expect(hub.send).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(25_001);

      expect(engine.abortSessionByPath).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // [BYOK-EQUALITY · 2026-04-27 night] retry-after-prefetch 仅适用于 prefetch 还在的路径(非 brain)。
  // 改 provider=openai 来保留这条覆盖。后续若全 provider 都移除 prefetch,这条改 .skip 即可。
  it("does not retry pending-tool text after local prefetch evidence (non-brain path)", async () => {
    engine.currentModel = { id: "gpt-4o", provider: "openai", name: "GPT-4o" };
    engine.resolveModelOverrides = vi.fn((model) => model);
    let modelCallCount = 0;
    hub.send = vi.fn(async () => {
      modelCallCount += 1;
      if (modelCallCount === 1) {
        subscribed({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            delta: "我来搜索一下天气资料。",
          },
        }, "/sessions/current.jsonl");
        subscribed({ type: "turn_end" }, "/sessions/current.jsonl");
      }
    });
    reportResearchMock.inferReportResearchKind.mockReturnValue("weather");
    reportResearchMock.buildReportResearchContext.mockResolvedValue("【系统已完成天气工具预取】\n深圳今日天气晴。");

    const res = await app.request("/ws");
    expect(res.status).toBe(200);

    connections[0].handlers.onMessage({
      data: JSON.stringify({ type: "prompt", text: "今天深圳天气如何" }),
    }, connections[0].client);

    await vi.waitFor(() => expect(hub.send).toHaveBeenCalledTimes(1));

    expect(clients[0].sent).not.toContainEqual(expect.objectContaining({
      type: "turn_retry",
      sessionPath: "/sessions/current.jsonl",
    }));
  });
});
