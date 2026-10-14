import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import { runCodeTaskWithEvents, type CodeAgentEvent } from "../src/commands/code.js";
import type { ChatMessage } from "../src/brain-client.js";

let tmp = "";
beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-cli-recovery-")); });
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

function sse(content: string): string {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");
}

function rawSsePayloads(payloads: string[]): string {
  return [
    ...payloads.flatMap((payload) => [`data: ${payload}`, ""]),
    "data: [DONE]",
    "",
  ].join("\n");
}

async function withRawBrainServer(handler: (body: unknown, count: number) => string, run: (url: string) => Promise<void>): Promise<void> {
  let count = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/chat/completions" && req.method === "POST") {
      let raw = "";
      req.on("data", (chunk) => { raw += String(chunk); });
      req.on("end", () => {
        count += 1;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(handler(JSON.parse(raw), count));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server failed to bind");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("model evidence recovery", () => {
  it("reports failure instead of manufacturing an answer when Brain recovery also fails", async () => {
    const events: CodeAgentEvent[] = [];
    let recoveryRequests = 0;
    await withRawBrainServer((body: any, count) => {
      if (count > 1) {
        recoveryRequests += 1;
        expect(body.tool_choice).toBe("none");
        expect(body.tools).toBeUndefined();
        expect(JSON.stringify(body.messages)).toContain("2026/06/22 00:00 Spain vs Saudi Arabia");
      }
      return rawSsePayloads([
      JSON.stringify({
        object: "lynn.tool_progress",
        tool_progress: {
          event: "end",
          name: "web_search",
          ok: true,
          summary: "2026/06/22 00:00 Spain vs Saudi Arabia (Scheduled)",
          details: ["2026/06/22 03:00 Belgium vs Iran (Scheduled)"],
        },
      }),
      JSON.stringify({ object: "lynn.error", error: "all providers failed", code: "BRAIN_ALL_FAILED" }),
    ]);
    }, async (brainUrl) => {
      await expect(runCodeTaskWithEvents(parseArgs([
        "code",
        "今晚世界杯有几场比赛",
        "--cwd",
        tmp,
        "--brain-url",
        brainUrl,
        "--max-steps",
        "1",
      ]), "今晚世界杯有几场比赛", (event) => {
        events.push(event);
      })).rejects.toThrow("Brain 本轮所有模型路由均未完成请求");
    });

    const finished = events.find((event): event is Extract<CodeAgentEvent, { type: "task.finished" }> => event.type === "task.finished");
    expect(finished?.ok).not.toBe(true);
    expect(recoveryRequests).toBe(1);
    expect(events.some((event) => event.type === "assistant.delta" && event.text.includes("工具证据"))).toBe(false);
  });

  it("recovers through one model-only request with complete tool evidence", async () => {
    const events: CodeAgentEvent[] = [];
    let requests = 0;
    const result = "full evidence " + "detail ".repeat(500) + "SOURCE_END";
    await withRawBrainServer((body: any, count) => {
      requests = count;
      if (count === 1) return rawSsePayloads([
        JSON.stringify({ object: "lynn.tool_progress", tool_progress: {
          event: "end", name: "weather", ok: true, result,
          tool_call: { id: "weather-call", type: "function", function: { name: "weather", arguments: '{"location":"顺德大良"}' } },
        } }),
        JSON.stringify({ object: "lynn.error", error: "all providers failed", code: "BRAIN_ALL_FAILED" }),
      ]);
      expect(body.tool_choice).toBe("none");
      expect(body.tools).toBeUndefined();
      expect(body.messages.some((message: ChatMessage) => message.role === "tool" && message.content === result)).toBe(true);
      return sse("模型根据完整证据给出的最终答案。");
    }, async (brainUrl) => {
      await expect(runCodeTaskWithEvents(parseArgs([
        "code", "顺德大良天气", "--cwd", tmp, "--brain-url", brainUrl, "--max-steps", "1",
      ]), "顺德大良天气", event => events.push(event))).resolves.toBe(0);
    });
    expect(requests).toBe(2);
    expect(events.some(event => event.type === "task.finished" && event.ok && event.text === "模型根据完整证据给出的最终答案。")).toBe(true);
  });

});
