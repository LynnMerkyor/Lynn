import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/args.js";
import { mergePromptAndStdin, runPrompt } from "../src/commands/prompt.js";

const cliRoot = fileURLToPath(new URL("..", import.meta.url));

describe("prompt stdin handling", () => {
  it("uses stdin as the whole prompt for dash", () => {
    expect(mergePromptAndStdin("-", "file body\n")).toBe("file body");
  });

  it("appends piped stdin as context when a prompt is present", () => {
    expect(mergePromptAndStdin("summarize", "hello")).toBe("summarize\n\n--- stdin ---\nhello");
  });

  it("uses stdin when no prompt is present", () => {
    expect(mergePromptAndStdin("", "hello")).toBe("hello");
  });

  it("answers local CLI version questions without contacting Brain", async () => {
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(runPrompt(parseArgs([
        "-p",
        "你的版本号",
        "--json",
        "--brain-url",
        "http://127.0.0.1:1",
      ]), { json: true })).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
    }

    expect(output).toContain("\"type\":\"assistant.delta\"");
    expect(output).toContain("Lynn CLI 版本");
    expect(output).toContain("\"local\":true");
  });

  it("answers local model route questions without contacting Brain", async () => {
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(runPrompt(parseArgs([
        "-p",
        "你现在工作模型是什么模型",
        "--json",
        "--brain-url",
        "http://127.0.0.1:1",
      ]), { json: true })).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
    }

    expect(output).toContain("\"type\":\"assistant.delta\"");
    expect(output).toContain("模型路由:StepFun 3.7 Flash");
    expect(output).toContain("Lynn CLI 版本");
    expect(output).toContain("\"local\":true");
    expect(output).not.toContain("fetch failed");
  });

  it("answers deterministic zod schema prompts without contacting Brain", async () => {
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(runPrompt(parseArgs([
        "-p",
        "写一个 zod schema 校验 release manifest",
        "--json",
        "--brain-url",
        "http://127.0.0.1:1",
      ]), { json: true })).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
    }

    expect(output).toContain("\"type\":\"assistant.delta\"");
    expect(output).toContain("import { z } from 'zod';");
    expect(output).toContain("z.object({");
    expect(output).toContain("\"deterministic\":true");
  });

  it("answers known official research prompts without contacting Brain", async () => {
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(runPrompt(parseArgs([
        "-p",
        "查 Anthropic docs 是否提到 Claude Code",
        "--json",
        "--brain-url",
        "http://127.0.0.1:1",
      ]), { json: true })).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
    }

    expect(output).toContain("\"type\":\"tool_progress\"");
    expect(output).toContain("Anthropic 官方文档中有 Claude Code 文档入口");
    expect(output).toContain("docs.anthropic.com");
    expect(output).toContain("\"researchPrefetch\":true");
    expect(output).not.toContain("fetch failed");
  });

  it("answers a direct ESPN zero as no tonight World Cup matches without contacting Brain", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ events: [] }),
    })));
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(runPrompt(parseArgs([
        "-p",
        "今晚世界杯有比赛吗",
        "--json",
        "--brain-url",
        "http://127.0.0.1:1",
      ]), { json: true })).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
      vi.unstubAllGlobals();
    }

    expect(output).toContain('"name":"sports_score"');
    expect(output).toContain("今晚没有世界杯比赛");
    expect(output).toContain("按北京时间口径返回 0 场");
    expect(output).toContain('"researchPrefetch":true');
    expect(output).not.toContain("不等于赛事数量为 0");
  });

  it("answers Apple notarization official research prompts with local evidence", async () => {
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(runPrompt(parseArgs([
        "-p",
        "查 Apple 开发者文档里 notarization 的用途",
        "--json",
        "--brain-url",
        "http://127.0.0.1:1",
      ]), { json: true })).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
    }

    expect(output).toContain("\"type\":\"tool_progress\"");
    expect(output).toContain("Apple notarization 的用途");
    expect(output).toContain("developer.apple.com/documentation/security/notarizing_macos_software_before_distribution");
    expect(output).toContain("\"researchPrefetch\":true");
    expect(output).not.toContain("fetch failed");
  });

  it("answers latest Claude public model prompts with the bounded official answer", async () => {
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(runPrompt(parseArgs([
        "-p",
        "Claude 最新公开模型是哪一代？",
        "--json",
        "--brain-url",
        "http://127.0.0.1:1",
      ]), { json: true })).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
    }

    expect(output).toContain("\"type\":\"tool_progress\"");
    expect(output).toContain("Claude 4 系列");
    expect(output).toContain("docs.anthropic.com/en/docs/about-claude/models/overview");
    expect(output).toContain("\"researchPrefetch\":true");
    expect(output).not.toContain("抓取失败");
    expect(output).not.toContain("fetch failed");
  });

  it("answers Japan tourist visa prompts with source boundaries instead of thin miss text", async () => {
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(runPrompt(parseArgs([
        "-p",
        "查一下中国游客去日本旅行签证最新材料要求，列来源和不确定点",
        "--json",
        "--brain-url",
        "http://127.0.0.1:1",
      ]), { json: true })).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
    }

    expect(output).toContain("中国游客赴日旅游签证材料");
    expect(output).toContain("日本国驻华大使馆签证入口");
    expect(output).toContain("\"researchPrefetch\":true");
    expect(output).not.toContain("工具结果中未查到");
  });

  it("runs prompt mode through CLI BYOK when local Brain is offline", async () => {
    const provider = http.createServer((request, response) => {
      expect(request.url).toBe("/v1/chat/completions");
      expect(request.headers.authorization).toBe("Bearer sk-command-test");
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        expect(JSON.parse(body)).toMatchObject({
          model: "command-model",
          stream: true,
        });
        const parsed = JSON.parse(body) as { messages?: Array<{ role?: string; content?: unknown }> };
        expect(parsed.messages?.[0]).toMatchObject({
          role: "system",
          content: expect.stringContaining("Current model route shown to the user: CLI BYOK: command-model"),
        });
        expect(parsed.messages?.at(-1)).toMatchObject({ role: "user", content: "hello" });
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end([
          "data: {\"choices\":[{\"delta\":{\"content\":\"command byok ok\"}}]}",
          "",
          "data: [DONE]",
          "",
        ].join("\n"));
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("provider test server failed to listen");

    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(runPrompt(parseArgs([
        "-p",
        "hello",
        "--json",
        "--brain-url",
        "http://127.0.0.1:1",
        "--base-url",
        `http://127.0.0.1:${address.port}/v1`,
        "--api-key",
        "sk-command-test",
        "--model",
        "command-model",
      ]), { json: true })).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }

    expect(output).toContain("\"text\":\"command byok ok\"");
    expect(output).toContain("\"activeProvider\":\"cli-byok:openai-compatible\"");
    expect(output).toContain("\"ok\":true");
  });

  it("passes prompt --image as multimodal content through CLI BYOK", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-cli-prompt-image-"));
    const image = path.join(tmp, "shot.png");
    await fs.writeFile(image, Buffer.from("89504e470d0a1a0a", "hex"));
    let body = "";
    const provider = http.createServer((request, response) => {
      expect(request.url).toBe("/v1/chat/completions");
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end([
          "data: {\"choices\":[{\"delta\":{\"content\":\"image prompt ok\"}}]}",
          "",
          "data: [DONE]",
          "",
        ].join("\n"));
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("provider test server failed to listen");

    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(runPrompt(parseArgs([
        "-p",
        "describe screenshot",
        "--image",
        image,
        "--json",
        "--brain-url",
        "http://127.0.0.1:1",
        "--base-url",
        `http://127.0.0.1:${address.port}/v1`,
        "--api-key",
        "sk-command-test",
        "--model",
        "command-model",
      ]), { json: true })).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      await fs.rm(tmp, { recursive: true, force: true });
    }

    const parsed = JSON.parse(body) as { messages?: Array<{ content?: unknown }> };
    expect(parsed.messages?.[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("Current model route shown to the user: CLI BYOK: command-model"),
    });
    const content = parsed.messages?.at(-1)?.content;
    expect(Array.isArray(content)).toBe(true);
    expect(JSON.stringify(content)).toContain("data:image/png;base64");
    expect(output).toContain("\"images\":[");
    expect(output).toContain("\"text\":\"image prompt ok\"");
  });

  it("exits after prompt mode reads optional stdin in non-TTY command usage", async () => {
    const provider = http.createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end([
          "data: {\"choices\":[{\"delta\":{\"content\":\"process exits\"}}]}",
          "",
          "data: [DONE]",
          "",
        ].join("\n"));
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("provider test server failed to listen");

    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [
        "--import",
        "tsx",
        "src/cli.ts",
        "-p",
        "hello",
        "--json",
        "--brain-url",
        "http://127.0.0.1:1",
        "--base-url",
        `http://127.0.0.1:${address.port}/v1`,
        "--api-key",
        "sk-command-test",
        "--model",
        "command-model",
      ], { cwd: cliRoot });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("CLI process did not exit"));
      }, 5000);
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
    await new Promise<void>((resolve) => provider.close(() => resolve()));

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("\"text\":\"process exits\"");
    expect(result.stdout).toContain("\"ok\":true");
  });

  it("retries hidden-reasoning-only streams twice before failing", async () => {
    let requests = 0;
    const provider = http.createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        requests += 1;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end([
          "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"thinking but no answer\"}}]}",
          "",
          "data: [DONE]",
          "",
        ].join("\n"));
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("provider test server failed to listen");

    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(runPrompt(parseArgs([
        "-p",
        "hello",
        "--json",
        "--brain-url",
        "http://127.0.0.1:1",
        "--base-url",
        `http://127.0.0.1:${address.port}/v1`,
        "--api-key",
        "sk-command-test",
        "--model",
        "command-model",
      ]), { json: true })).resolves.toBe(2);
    } finally {
      process.stdout.write = original;
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }

    expect(output).toContain("\"code\":\"empty_visible_answer\"");
    expect(output).toContain("\"type\":\"run.retry\"");
    expect(output).toContain("\"ok\":false");
    expect(output).toContain("\"reasoningReturned\":true");
    expect(output).not.toContain("\"ok\":true");
    expect(requests).toBe(3);
  });

  it("recovers when the hidden-reasoning retry returns visible content", async () => {
    let requests = 0;
    let retryBody = "";
    const provider = http.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        requests += 1;
        if (requests === 2) retryBody = body;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(requests === 1
          ? [
              "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"thinking but no answer\"}}]}",
              "",
              "data: [DONE]",
              "",
            ].join("\n")
          : [
              "data: {\"choices\":[{\"delta\":{\"content\":\"visible answer\"}}]}",
              "",
              "data: [DONE]",
              "",
            ].join("\n"));
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("provider test server failed to listen");

    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(runPrompt(parseArgs([
        "-p",
        "hello",
        "--json",
        "--brain-url",
        "http://127.0.0.1:1",
        "--base-url",
        `http://127.0.0.1:${address.port}/v1`,
        "--api-key",
        "sk-command-test",
        "--model",
        "command-model",
      ]), { json: true })).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }

    expect(requests).toBe(2);
    expect(output).toContain("\"type\":\"run.retry\"");
    expect(output).toContain("\"text\":\"visible answer\"");
    expect(output).toContain("\"ok\":true");
    expect(retryBody).toContain("previous attempt returned hidden reasoning");
  });

  it("can stop prompt JSON mode after a complete visible JSON boundary", async () => {
    const provider = http.createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"ok":true}' } }] })}\n\n`);
        setTimeout(() => {
          if (!response.destroyed) {
            response.end([
              `data: ${JSON.stringify({ choices: [{ delta: { content: " trailing text that should not be emitted" } }] })}`,
              "",
              "data: [DONE]",
              "",
            ].join("\n"));
          }
        }, 2000);
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("provider test server failed to listen");

    const original = process.stdout.write;
    let output = "";
    const oldAttempts = process.env.LYNN_CLI_BRAIN_RETRY_ATTEMPTS;
    const oldTimeout = process.env.LYNN_CLI_BRAIN_TIMEOUT_MS;
    const oldRetryBase = process.env.LYNN_CLI_BRAIN_RETRY_BASE_MS;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    const started = Date.now();
    let elapsedMs = 0;
    try {
      process.env.LYNN_CLI_BRAIN_RETRY_ATTEMPTS = "1";
      process.env.LYNN_CLI_BRAIN_RETRY_BASE_MS = "0";
      process.env.LYNN_CLI_BRAIN_TIMEOUT_MS = "50";
      await expect(runPrompt(parseArgs([
        "-p",
        "return json",
        "--json",
        "--stop-at-json",
        "--brain-url",
        "http://127.0.0.1:1",
        "--base-url",
        `http://127.0.0.1:${address.port}/v1`,
        "--api-key",
        "sk-command-test",
        "--model",
        "command-model",
      ]), { json: true })).resolves.toBe(0);
      elapsedMs = Date.now() - started;
    } finally {
      process.stdout.write = original;
      if (oldAttempts === undefined) delete process.env.LYNN_CLI_BRAIN_RETRY_ATTEMPTS;
      else process.env.LYNN_CLI_BRAIN_RETRY_ATTEMPTS = oldAttempts;
      if (oldRetryBase === undefined) delete process.env.LYNN_CLI_BRAIN_RETRY_BASE_MS;
      else process.env.LYNN_CLI_BRAIN_RETRY_BASE_MS = oldRetryBase;
      if (oldTimeout === undefined) delete process.env.LYNN_CLI_BRAIN_TIMEOUT_MS;
      else process.env.LYNN_CLI_BRAIN_TIMEOUT_MS = oldTimeout;
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }

    expect(elapsedMs).toBeLessThan(1500);
    expect(output).toContain("\"type\":\"run.boundary_stop\"");
    expect(output).toContain("\"text\":\"{\\\"ok\\\":true}\"");
    expect(output).toContain("\"ok\":true");
    expect(output).not.toContain("trailing text");
  });

  it("exits quietly when downstream closes a JSON pipe early", async () => {
    const provider = http.createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        const chunk = "x".repeat(4096);
        const lines = Array.from({ length: 200 }, () => [
          `data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}`,
          "",
        ]).flat();
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end([...lines, "data: [DONE]", ""].join("\n"));
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("provider test server failed to listen");

    const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
    const cliCommand = [
      quote(process.execPath),
      "--import",
      "tsx",
      "src/cli.ts",
      "-p",
      quote("hello"),
      "--json",
      "--brain-url",
      quote("http://127.0.0.1:1"),
      "--base-url",
      quote(`http://127.0.0.1:${address.port}/v1`),
      "--api-key",
      quote("sk-command-test"),
      "--model",
      quote("command-model"),
    ].join(" ");

    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn("bash", ["-lc", `${cliCommand} | head -n 1`], { cwd: cliRoot });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("CLI pipeline did not exit"));
      }, 5000);
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
    await new Promise<void>((resolve) => provider.close(() => resolve()));

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("\"type\":\"run.started\"");
    expect(result.stderr).not.toContain("EPIPE");
    expect(result.stderr).not.toContain("write EPIPE");
  });
});
