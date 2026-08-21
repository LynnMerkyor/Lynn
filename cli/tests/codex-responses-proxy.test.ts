import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startCodexResponsesProxy, type CodexResponsesProxy } from "../src/codex-responses-proxy.js";

const servers: http.Server[] = [];
const proxies: CodexResponsesProxy[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.stop()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function parseSse(raw: string): Array<Record<string, unknown>> {
  return raw
    .split(/\n\n/u)
    .map((block) => block.split(/\r?\n/u).find((line) => line.startsWith("data: "))?.slice(6))
    .filter((value): value is string => !!value && value !== "[DONE]")
    .map((value) => JSON.parse(value) as Record<string, unknown>);
}

describe("Codex Responses loopback proxy", () => {
  it("authenticates locally and adapts Responses tools to a Chat-only BYOK provider", async () => {
    let providerRequest: Record<string, unknown> | null = null;
    const provider = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += String(chunk); });
      req.on("end", () => {
        providerRequest = JSON.parse(body) as Record<string, unknown>;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-read", type: "function", function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" } }] }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 } })}\n\n`);
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    servers.push(provider);
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("provider did not bind");

    const proxy = await startCodexResponsesProxy({
      brainUrl: "http://unused.invalid",
      provider: {
        provider: "test-chat",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "test-chat-model",
        apiKey: "secret-not-for-output",
      },
      reasoning: { effort: "auto", display: "never" },
    });
    proxies.push(proxy);

    const unauthorized = await fetch(`${proxy.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hello" }),
    });
    expect(unauthorized.status).toBe(401);
    const unicodeUnauthorized = await fetch(`${proxy.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${"é".repeat(64)}` },
      body: JSON.stringify({ input: "hello" }),
    });
    expect(unicodeUnauthorized.status).toBe(401);

    const response = await fetch(`${proxy.baseUrl}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${proxy.bearerToken}`,
      },
      body: JSON.stringify({
        model: "test-chat-model",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "read" }] }],
        tools: [{ type: "function", name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } } } }],
        stream: true,
      }),
    });
    const events = parseSse(await response.text());
    const tools = (providerRequest as { tools?: Array<{ function?: { name?: string } }> } | null)?.tools || [];

    expect(response.status).toBe(200);
    expect(response.headers.get("x-lynn-harness-mode")).toBe("byok-chat-compat");
    expect(tools).toHaveLength(1);
    expect(tools[0]?.function?.name).toBe("read_file");
    expect(events.some((event) => event.type === "response.output_item.added"
      && (event.item as { type?: string; name?: string })?.type === "function_call"
      && (event.item as { name?: string })?.name === "read_file")).toBe(true);
    expect(events.filter((event) => event.type === "response.completed")).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("secret-not-for-output");
  });

  it("signs and streams the Brain Responses path when no CLI BYOK profile is configured", async () => {
    let upstreamHeaders: http.IncomingHttpHeaders = {};
    const brain = http.createServer((req, res) => {
      upstreamHeaders = req.headers;
      req.resume();
      req.on("end", () => {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "x-lynn-harness-mode": "model-only",
          "x-brain-version": "test",
        });
        res.end(`data: ${JSON.stringify({ type: "response.completed", response: { id: "resp-brain", status: "completed", output: [] } })}\n\n`);
      });
    });
    await new Promise<void>((resolve) => brain.listen(0, "127.0.0.1", resolve));
    servers.push(brain);
    const address = brain.address();
    if (!address || typeof address === "string") throw new Error("brain did not bind");
    const lynnHome = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-codex-proxy-home-"));
    tempDirs.push(lynnHome);
    const proxy = await startCodexResponsesProxy({
      brainUrl: `http://127.0.0.1:${address.port}`,
      reasoning: { effort: "auto", display: "never" },
      lynnHome,
    });
    proxies.push(proxy);

    const response = await fetch(`${proxy.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${proxy.bearerToken}` },
      body: JSON.stringify({ model: "lynn-brain-router", input: "hello", stream: true }),
    });
    const raw = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-lynn-harness-mode")).toBe("model-only");
    expect(upstreamHeaders["x-agent-key"]).toMatch(/^ak_[a-f0-9]{32}$/);
    expect(upstreamHeaders["x-lynn-signature"]).toMatch(/^v1:[a-f0-9]{64}$/);
    expect(upstreamHeaders["x-lynn-timestamp"]).toMatch(/^\d+$/);
    expect(upstreamHeaders["x-lynn-nonce"]).toMatch(/^[a-f0-9]{24}$/);
    expect(raw).toContain("response.completed");
  });
});
