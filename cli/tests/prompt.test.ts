import http from "node:http";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import { mergePromptAndStdin, runPrompt } from "../src/commands/prompt.js";

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
          messages: [{ role: "user", content: "hello" }],
        });
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
});
