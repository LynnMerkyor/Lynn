import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAppServerClient } from "../shared/codex-app-server-client.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url));
const clients: CodexAppServerClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.stop()));
});

function createClient(scenario?: string): CodexAppServerClient {
  const client = new CodexAppServerClient({
    command: process.execPath,
    commandArgs: scenario ? [fixture, scenario] : [fixture],
    cwd: path.dirname(fixture),
    requestTimeoutMs: 2_000,
    clientVersion: "test",
  });
  clients.push(client);
  return client;
}

describe("Codex app-server JSONL client", () => {
  it("handshakes, pairs RPC responses, handles reverse tool calls, and completes a turn", async () => {
    const client = createClient();
    await expect(client.start()).resolves.toMatchObject({ userAgent: "fake-codex" });
    expect(client.pid).toBeTypeOf("number");

    const notifications: string[] = [];
    client.onNotification((notification) => notifications.push(notification.method));
    client.onServerRequest((request) => {
      if (request.method === "item/tool/call") {
        client.respond(request.id, { contentItems: [{ type: "inputText", text: "README" }], success: true });
      }
    });

    const thread = await client.startThread({ cwd: process.cwd() });
    const threadId = String((thread.thread as { id?: string }).id);
    const started = await client.startTurn({ threadId, input: [{ type: "text", text: "hello", text_elements: [] }] });
    const turnId = String((started.turn as { id?: string }).id);
    const completed = await client.waitForTurn(threadId, turnId, { timeoutMs: 2_000 });

    expect(completed.turn).toMatchObject({ id: "turn-1", status: "completed" });
    expect(notifications).toContain("item/agentMessage/delta");
    expect(notifications).toContain("turn/completed");
  });

  it("times out unanswered requests without leaving the client stuck", async () => {
    const client = createClient();
    await client.start();
    await expect(client.request("never/reply", {}, { timeoutMs: 20 })).rejects.toThrow("timed out");
    await expect(client.startThread({ cwd: process.cwd() })).resolves.toHaveProperty("thread.id", "thread-1");
  });

  it("rejects an in-flight turn immediately when app-server exits", async () => {
    const client = createClient("crash");
    await client.start();
    const thread = await client.startThread({ cwd: process.cwd() });
    const threadId = String((thread.thread as { id?: string }).id);
    const started = await client.startTurn({ threadId, input: [{ type: "text", text: "crash", text_elements: [] }] });
    const turnId = String((started.turn as { id?: string }).id);

    await expect(client.waitForTurn(threadId, turnId)).rejects.toThrow(/exited/i);
  });
});
