import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLynnAgentSession } from "../core/agent-runtime/create-session.js";
import { SessionManager } from "../core/agent-runtime/session-manager.js";

function sseResponse(chunks) {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
  };
}

async function waitFor(condition, timeoutMs = 500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for condition");
}

describe("createLynnAgentSession native runtime", () => {
  let tempDir;
  let originalFetch;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-native-runtime-"));
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("queues follow-up prompts while a turn is streaming instead of recursing or throwing", async () => {
    const fetchMock = vi.fn(async () => sseResponse([
      "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n",
      "data: [DONE]\n\n",
    ]));
    globalThis.fetch = fetchMock;

    const { session } = await createLynnAgentSession({
      cwd: tempDir,
      sessionManager: SessionManager.create(tempDir, tempDir),
      model: {
        id: "test-model",
        provider: "test-provider",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:65530/v1",
        apiKey: "test-key",
      },
    });

    session.isStreaming = true;
    await expect(session.followUp("queued message")).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();

    session.isStreaming = false;
    session.drainPendingPrompts();
    await waitFor(() => fetchMock.mock.calls.length === 1);

    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody.messages.at(-1)).toMatchObject({
      role: "user",
      content: "queued message",
    });
  });

  it("drops nameless streamed tool calls instead of executing empty tool cards", async () => {
    const fetchMock = vi.fn(async () => sseResponse([
      "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"\",\"function\":{\"name\":\"\",\"arguments\":\"{\\\"query\\\":\\\"世界杯\\\"}\"}}]}}]}\n\n",
      "data: {\"choices\":[{\"delta\":{\"content\":\"工具证据已整理。\"}}]}\n\n",
      "data: [DONE]\n\n",
    ]));
    globalThis.fetch = fetchMock;
    const manager = SessionManager.create(tempDir, tempDir);
    const events = [];

    const { session } = await createLynnAgentSession({
      cwd: tempDir,
      sessionManager: manager,
      model: {
        id: "brain-router",
        provider: "brain",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:65530/v1",
        apiKey: "test-key",
      },
      tools: [{
        name: "web_search",
        description: "search",
        parameters: { type: "object", properties: {} },
        execute: vi.fn(async () => ({ content: [{ type: "text", text: "should not run" }] })),
      }],
    });
    session.subscribe((event) => events.push(event));

    await session.prompt("世界杯");

    expect(events.some((event) => event.type === "tool_execution_start")).toBe(false);
    const messages = manager.buildSessionContext().messages;
    expect(messages.some((message) => message.role === "tool")).toBe(false);
    expect(JSON.stringify(messages)).not.toContain("Tool not found");
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "工具证据已整理。",
    });
  });
});
