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
});
