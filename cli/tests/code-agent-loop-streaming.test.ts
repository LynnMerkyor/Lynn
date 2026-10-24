import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as readTools from "../src/tools/read-file.js";
import { parseArgs } from "../src/args.js";
import { runCode } from "../src/commands/code.js";

let tmp = "";

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-stream-"));
  await fs.writeFile(path.join(tmp, "hello.txt"), "hello\n", "utf8");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmp, { recursive: true, force: true });
});

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function toolDelta(index: number, id: string, name: string, args: unknown): string {
  return sse({ choices: [{ delta: { tool_calls: [{ index, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
}

async function withStreamServer(
  handler: (body: unknown, count: number, res: http.ServerResponse) => void,
  run: (url: string) => Promise<void>,
): Promise<void> {
  let count = 0;
  const server = http.createServer((req, res) => {
    if (req.url !== "/v1/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    let raw = "";
    req.on("data", (chunk) => { raw += String(chunk); });
    req.on("end", () => {
      count += 1;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      handler(JSON.parse(raw), count, res);
    });
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

async function captureStdout(run: () => Promise<void>): Promise<string> {
  const original = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    await run();
  } finally {
    process.stdout.write = original;
  }
  return output;
}

describe("streaming tool execution", () => {
  it("waits for all preceding reads before starting a streamed write", async () => {
    const readFile = readTools.readFileTool;
    let writeOvertookRead = false;
    vi.spyOn(readTools, "readFileTool").mockImplementation(async (...args) => {
      if (args[1] === "hello.txt") {
        await new Promise(resolve => setTimeout(resolve, 150));
        writeOvertookRead = await fs.access(path.join(tmp, "ordered.txt")).then(() => true, () => false);
      }
      return readFile(...args);
    });
    await withStreamServer((_body, count, response) => {
      if (count === 1) {
        response.write(toolDelta(0, "slow_read", "read_file", { path: "hello.txt" }));
        response.write(toolDelta(1, "ordered_write", "write_file", { path: "ordered.txt", text: "safe" }));
        response.write(toolDelta(2, "read_after_write", "read_file", { path: "ordered.txt" }));
      } else response.write(sse({ choices: [{ delta: { content: "completed" } }] }));
      response.end("data: [DONE]\n\n");
    }, async brainUrl => {
      const output = await captureStdout(async () => {
        expect(await runCode(parseArgs(["code", "read then write then read", "--cwd", tmp, "--brain-url", brainUrl, "--approval", "yolo", "--sandbox", "danger-full-access", "--max-steps", "3", "--json"]))).toBe(0);
      });
      expect(output).toContain('"text":"safe"');
    });
    expect(writeOvertookRead).toBe(false);
    expect(await fs.readFile(path.join(tmp, "ordered.txt"), "utf8")).toBe("safe");
  });

  it("does not execute tool JSON left in an interrupted text stream", async () => {
    await withStreamServer((_body, count, response) => {
      if (count === 1) {
        response.write(sse({ choices: [{ delta: { content: '<tool_call>{"tool":"write_file","args":{"path":"unsafe.txt","text":"bad"}}</tool_call>' } }] }));
        setTimeout(() => response.destroy(), 50);
      } else {
        response.write(sse({ choices: [{ delta: { content: "The stream failed." } }] }));
        response.end("data: [DONE]\n\n");
      }
    }, async brainUrl => {
      await captureStdout(async () => { await runCode(parseArgs(["code", "interrupted text", "--cwd", tmp, "--brain-url", brainUrl, "--approval", "yolo", "--sandbox", "danger-full-access", "--max-steps", "2", "--json"])).catch(() => undefined); });
    });
    await expect(fs.access(path.join(tmp, "unsafe.txt"))).rejects.toThrow();
  });
  it("runs a tool before the model stream finishes", async () => {
    let streamFinishedAt = 0;
    let output = "";
    await withStreamServer((body, count, res) => {
      if (count === 1) {
        res.write(toolDelta(0, "call_bash", "bash", {
          command: "node -e \"require('fs').writeFileSync('marker.txt',String(Date.now()))\"",
        }));
        setTimeout(() => {
          streamFinishedAt = Date.now();
          res.write(sse({ choices: [{ delta: { content: "late text" } }] }));
          res.write("data: [DONE]\n\n");
          res.end();
        }, 1_500);
        return;
      }
      res.write(sse({ choices: [{ delta: { content: "finished" } }] }));
      res.write("data: [DONE]\n\n");
      res.end();
    }, async (brainUrl) => {
      output = await captureStdout(async () => {
        await expect(runCode(parseArgs([
          "code", "run a tool early", "--cwd", tmp, "--brain-url", brainUrl,
          "--approval", "yolo", "--sandbox", "danger-full-access", "--max-steps", "3", "--json",
        ]))).resolves.toBe(0);
      });
    });

    const marker = Number(await fs.readFile(path.join(tmp, "marker.txt"), "utf8"));
    expect(marker).toBeGreaterThan(0);
    expect(marker).toBeLessThan(streamFinishedAt);
    expect(output).toContain('"type":"code.tool.result"');
  });

  it("keeps a completed tool result when the stream dies afterwards", async () => {
    let output = "";
    let secondTurnBody = "";
    await withStreamServer((body, count, res) => {
      if (count === 1) {
        res.write(toolDelta(0, "call_read", "read_file", { path: "hello.txt" }));
        setTimeout(() => res.destroy(), 60);
        return;
      }
      secondTurnBody = JSON.stringify(body);
      res.write(sse({ choices: [{ delta: { content: "recovered after interruption" } }] }));
      res.write("data: [DONE]\n\n");
      res.end();
    }, async (brainUrl) => {
      output = await captureStdout(async () => {
        await expect(runCode(parseArgs([
          "code", "read then die", "--cwd", tmp, "--brain-url", brainUrl,
          "--max-steps", "3", "--json",
        ]))).resolves.toBe(0);
      });
    });

    expect(output).toContain('"type":"code.stream.interrupted"');
    expect(output).toContain('"tool":"read_file"');
    expect(secondTurnBody).toContain("Tool result for read_file");
    expect(secondTurnBody).toContain("stream ended before the turn completed");
    expect(output).toContain("recovered after interruption");
  });

  it("serialises a streamed write before a later streamed read", async () => {
    let output = "";
    await withStreamServer((body, count, res) => {
      if (count === 1) {
        res.write(toolDelta(0, "call_write", "write_file", { path: "made.txt", text: "streamed\n" }));
        res.write(toolDelta(1, "call_read", "read_file", { path: "made.txt" }));
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.write(sse({ choices: [{ delta: { content: "all done" } }] }));
      res.write("data: [DONE]\n\n");
      res.end();
    }, async (brainUrl) => {
      output = await captureStdout(async () => {
        await expect(runCode(parseArgs([
          "code", "streamed write then read", "--cwd", tmp, "--brain-url", brainUrl,
          "--approval", "yolo", "--max-steps", "3", "--json",
        ]))).resolves.toBe(0);
      });
    });

    expect(await fs.readFile(path.join(tmp, "made.txt"), "utf8")).toBe("streamed\n");
    expect(output).toContain('"text":"streamed\\n"');
  });
});
