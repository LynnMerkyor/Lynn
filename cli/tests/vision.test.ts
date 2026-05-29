import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import { runVisionCommand, buildVisionPrompt } from "../src/commands/vision.js";
import { buildImageContentParts, inferImageMime } from "../src/media.js";
import { setLang } from "../src/i18n.js";

let tmp = "";
let png = "";

beforeEach(() => setLang("en"));
afterEach(() => setLang(null));

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-cli-vision-"));
  png = path.join(tmp, "shot.png");
  await fs.writeFile(png, Buffer.from("89504e470d0a1a0a", "hex"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("MiMo vision commands", () => {
  it("builds image content parts for MiMo multimodal routing", async () => {
    const parts = await buildImageContentParts(png, "describe");

    expect(parts[0]).toEqual({ type: "text", text: "describe" });
    expect(parts[1].type).toBe("image_url");
    expect(JSON.stringify(parts[1])).toContain("data:image/png;base64");
    expect(inferImageMime("a.webp")).toBe("image/webp");
  });

  it("renders grounding prompt as normalized JSON-first instruction", () => {
    const prompt = buildVisionPrompt("ground", "Submit button");

    expect(prompt).toContain("Target: Submit button");
    expect(prompt).toContain("\"x\"");
    expect(prompt).toContain("normalized");
  });

  it("runs see command in mock mode", async () => {
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(runVisionCommand(parseArgs(["see", png, "what is this", "--mock-brain"]), "see")).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
    }
    expect(output).toContain("Mock see");
    expect(output).toContain("what is this");
  });

  it("runs vision through CLI BYOK when Brain is offline", async () => {
    let body = "";
    const provider = http.createServer((request, response) => {
      expect(request.url).toBe("/v1/chat/completions");
      expect(request.headers.authorization).toBe("Bearer sk-vision-test");
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end([
          `data: ${JSON.stringify({ choices: [{ delta: { content: "vision byok ok" } }] })}`,
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
      await expect(runVisionCommand(parseArgs([
        "see",
        png,
        "what is this UI?",
        "--json",
        "--brain-url",
        "http://127.0.0.1:1",
        "--base-url",
        `http://127.0.0.1:${address.port}/v1`,
        "--api-key",
        "sk-vision-test",
        "--model",
        "vision-model",
      ]), "see")).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }

    const parsed = JSON.parse(body) as {
      model?: string;
      messages?: Array<{ content?: unknown }>;
    };
    expect(parsed.model).toBe("vision-model");
    expect(JSON.stringify(parsed.messages?.[0]?.content)).toContain("what is this UI?");
    expect(JSON.stringify(parsed.messages?.[0]?.content)).toContain("data:image/png;base64");
    expect(output).toContain("\"activeProvider\":\"cli-byok:openai-compatible\"");
    expect(output).toContain("\"text\":\"vision byok ok\"");
  });

  it("emits structured grounding boxes in json mode", async () => {
    const provider = http.createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end([
          `data: ${JSON.stringify({ choices: [{ delta: { content: '{"x":0.25,"y":0.5,"w":0.2,"h":0.1,"confidence":0.88,"label":"submit"}' } }] })}`,
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
      await expect(runVisionCommand(parseArgs([
        "ground",
        png,
        "Submit",
        "--json",
        "--brain-url",
        "http://127.0.0.1:1",
        "--base-url",
        `http://127.0.0.1:${address.port}/v1`,
        "--api-key",
        "sk-vision-test",
        "--model",
        "vision-model",
      ]), "ground")).resolves.toBe(0);
    } finally {
      process.stdout.write = original;
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }

    const events = output.trim().split(/\n+/).map((line) => JSON.parse(line) as { type?: string; boxes?: unknown[] });
    const result = events.find((event) => event.type === "vision.result");
    expect(result?.boxes).toEqual([{
      label: "submit",
      x: 0.25,
      y: 0.5,
      width: 0.2,
      height: 0.1,
      confidence: 0.88,
    }]);
  });
});
