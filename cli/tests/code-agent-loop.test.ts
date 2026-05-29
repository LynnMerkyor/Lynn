import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import { runCode } from "../src/commands/code.js";

let tmp = "";

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-cli-agent-"));
  await fs.writeFile(path.join(tmp, "hello.txt"), "hello\n", "utf8");
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function sse(content: string): string {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");
}

async function withBrainServer(handler: (body: unknown, count: number) => string, run: (url: string) => Promise<void>): Promise<void> {
  let count = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/chat/completions" && req.method === "POST") {
      let raw = "";
      req.on("data", (chunk) => { raw += String(chunk); });
      req.on("end", () => {
        count += 1;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(sse(handler(JSON.parse(raw), count)));
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

describe("code agent loop", () => {
  it("executes a model-requested apply_patch tool and feeds the result back", async () => {
    const patch = [
      "diff --git a/hello.txt b/hello.txt",
      "--- a/hello.txt",
      "+++ b/hello.txt",
      "@@ -1 +1 @@",
      "-hello",
      "+lynn",
      "",
    ].join("\n");
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await withBrainServer((_body, count) => count === 1
        ? JSON.stringify({ tool: "apply_patch", args: { patch } })
        : "Changed hello.txt and applied the patch.",
      async (brainUrl) => {
        await expect(runCode(parseArgs([
          "code",
          "change hello to lynn",
          "--cwd",
          tmp,
          "--brain-url",
          brainUrl,
          "--approval",
          "yolo",
          "--max-steps",
          "3",
          "--json",
        ]))).resolves.toBe(0);
      });
    } finally {
      process.stdout.write = original;
    }
    const text = await fs.readFile(path.join(tmp, "hello.txt"), "utf8");
    expect(text).toContain("lynn");
    expect(output).toContain('"type":"code.tool.requested"');
    expect(output).toContain('"tool":"apply_patch"');
    expect(output).toContain("Changed hello.txt");
  });
});
