import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import { inspectCacheSession, renderCacheDoctor, runCache } from "../src/commands/cache.js";
import { appendSessionLine, appendSessionMetadata } from "../src/session/store.js";

let tmp = "";
const originalDataDir = process.env.LYNN_DATA_DIR;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-cache-command-"));
  process.env.LYNN_DATA_DIR = tmp;
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.LYNN_DATA_DIR;
  else process.env.LYNN_DATA_DIR = originalDataDir;
});

async function captureStdout(run: () => Promise<number>): Promise<{ code: number; output: string }> {
  const original = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await run();
    return { code, output };
  } finally {
    process.stdout.write = original;
  }
}

async function createSessionWithCache(input: { drift?: boolean; cacheHit?: number; cacheMiss?: number } = {}): Promise<string> {
  let sessionPath = await appendSessionLine({
    dataDir: tmp,
    cwd: "/repo",
    title: "cache",
    line: { type: "user", content: "inspect cache" },
  });
  sessionPath = await appendSessionLine({
    dataDir: tmp,
    sessionPath,
    cwd: "/repo",
    title: "cache",
    line: { type: "assistant", content: "done" },
  });
  await appendSessionMetadata({
    dataDir: tmp,
    sessionPath,
    data: {
      kind: "code_task",
      usageRecords: [
        {
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
            prompt_cache_hit_tokens: input.cacheHit ?? 80,
            prompt_cache_miss_tokens: input.cacheMiss ?? 20,
          },
          durationMs: 1000,
        },
      ],
      cacheDiagnostics: {
        stablePrefixHash: "prefixaaa",
        stablePrefixChars: 1200,
        stableFrameCount: 2,
        volatileFrameCount: 2,
        resumeMessageCount: 4,
      },
    },
  });
  if (input.drift) {
    await appendSessionMetadata({
      dataDir: tmp,
      sessionPath,
      data: {
        kind: "code_task",
        cacheDiagnostics: {
          stablePrefixHash: "prefixbbb",
          stablePrefixChars: 1300,
          stableFrameCount: 2,
          volatileFrameCount: 3,
        },
      },
    });
  }
  return sessionPath;
}

describe("cache command", () => {
  it("renders a cache doctor report for an explicit session", async () => {
    const sessionPath = await createSessionWithCache();

    const result = await inspectCacheSession(sessionPath);
    const output = renderCacheDoctor(result);

    expect(result.ok).toBe(true);
    expect(output).toContain("Lynn cache doctor");
    expect(output).toContain("status: OK");
    expect(output).toContain("prefixaaa");
    expect(output).toContain("80%");
    expect(output).toContain("Stable prefix is consistent");
  });

  it("defaults to the latest session and emits JSON for agents", async () => {
    const sessionPath = await createSessionWithCache();
    const { code, output } = await captureStdout(() => runCache(parseArgs(["cache", "doctor", "--json"]), true));
    const parsed = JSON.parse(output) as { type: string; sessionPath: string; ok: boolean; stats: { cacheHitRatio: number } };

    expect(code).toBe(0);
    expect(parsed.type).toBe("cache.doctor");
    expect(parsed.sessionPath).toBe(sessionPath);
    expect(parsed.ok).toBe(true);
    expect(parsed.stats.cacheHitRatio).toBe(0.8);
  });

  it("warns on stable prefix drift and low cache hit ratio", async () => {
    const sessionPath = await createSessionWithCache({ drift: true, cacheHit: 10, cacheMiss: 90 });
    const { code, output } = await captureStdout(() => runCache(parseArgs(["cache", "doctor", sessionPath]), false));

    expect(code).toBe(1);
    expect(output).toContain("status: WARN");
    expect(output).toContain("Stable prefix drift detected");
    expect(output).toContain("Low prefix-cache hit ratio (10%)");
  });
});
