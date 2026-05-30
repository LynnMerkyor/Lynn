import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { checkCliUpdate, isInteractiveUpdateCommand, isUpdateNewer, maybePromptForCliUpdate } from "../src/self-update.js";

function ttyInput(text: string) {
  let sent = false;
  return Object.assign(new (class extends Readable {
    _read() {
      if (sent) {
        this.push(null);
        return;
      }
      sent = true;
      this.push(text);
    }
  })(), { isTTY: true });
}

class CaptureStream extends Writable {
  isTTY = true;
  output = "";

  _write(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.output += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    callback();
  }
}

describe("self update", () => {
  it("only checks interactive chat and empty code TUI launches", () => {
    expect(isInteractiveUpdateCommand({ command: "chat", positionals: [], flags: {} })).toBe(true);
    expect(isInteractiveUpdateCommand({ command: "code", positionals: [], flags: {} })).toBe(true);
    expect(isInteractiveUpdateCommand({ command: "code", positionals: [], flags: { p: "fix tests" } })).toBe(false);
    expect(isInteractiveUpdateCommand({ command: "code", positionals: ["fix tests"], flags: {} })).toBe(false);
    expect(isInteractiveUpdateCommand({ command: "worker", positionals: ["run"], flags: { jsonl: true } })).toBe(false);
    expect(isInteractiveUpdateCommand({ command: "chat", positionals: [], flags: { json: true } })).toBe(false);
  });

  it("compares versions and build ids", () => {
    expect(isUpdateNewer(
      { name: "@lynn/cli", version: "0.80.0-alpha.0", build: "aaa" },
      { version: "0.80.0-alpha.1", build: "aaa", tarballUrl: "https://example.test/lynn.tgz" },
    )).toBe(true);
    expect(isUpdateNewer(
      { name: "@lynn/cli", version: "0.80.0-alpha.0", build: "aaa" },
      { version: "0.80.0-alpha.0", build: "bbb", tarballUrl: "https://example.test/lynn.tgz" },
    )).toBe(true);
    expect(isUpdateNewer(
      { name: "@lynn/cli", version: "0.80.0", build: "aaa" },
      { version: "0.80.0-alpha.9", build: "zzz", tarballUrl: "https://example.test/lynn.tgz" },
    )).toBe(false);
  });

  it("skips network checks when disabled", async () => {
    const result = await checkCliUpdate(
      { name: "@lynn/cli", version: "0.80.0-alpha.0" },
      {
        env: { LYNN_CLI_UPDATE_CHECK: "0" },
        fetchImpl: async () => {
          throw new Error("should not fetch");
        },
      },
    );
    expect(result).toMatchObject({ available: false, reason: "disabled" });
  });

  it("skips network checks under test runners", async () => {
    const result = await checkCliUpdate(
      { name: "@lynn/cli", version: "0.80.0-alpha.0" },
      {
        env: { VITEST: "true" },
        fetchImpl: async () => {
          throw new Error("should not fetch");
        },
      },
    );
    expect(result).toMatchObject({ available: false, reason: "disabled" });
  });

  it("normalizes a valid manifest", async () => {
    const result = await checkCliUpdate(
      { name: "@lynn/cli", version: "0.80.0-alpha.0", build: "aaa" },
      {
        env: {},
        fetchImpl: async () => new Response(JSON.stringify({
          version: "0.80.0-alpha.0",
          build: "bbb",
          tarballUrl: "https://download.example.test/lynn.tgz",
        })),
      },
    );
    expect(result.available).toBe(true);
    expect(result.manifest).toMatchObject({
      version: "0.80.0-alpha.0",
      build: "bbb",
      tarballUrl: "https://download.example.test/lynn.tgz",
    });
  });

  it("lets an interactive user accept an update without changing the running session", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    let installedUrl = "";

    await maybePromptForCliUpdate(
      { command: "chat", positionals: [], flags: {} },
      { name: "@lynn/cli", version: "0.80.0", build: "old" },
      {
        stdin: ttyInput("y\n") as never,
        stdout: stdout as never,
        stderr,
        env: {},
        check: async () => ({
          available: true,
          manifest: {
            version: "0.80.0",
            build: "new",
            tarballUrl: "https://download.example.test/lynn-cli-0.80.0.tgz",
          },
        }),
        install: async (manifest) => {
          installedUrl = manifest.tarballUrl;
          return 0;
        },
      },
    );

    expect(installedUrl).toBe("https://download.example.test/lynn-cli-0.80.0.tgz");
    expect(stdout.output).toContain("Lynn CLI 已更新");
    expect(stderr.output).toBe("");
  });

  it("reports update failures without throwing or breaking the current version", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();

    await expect(maybePromptForCliUpdate(
      { command: "chat", positionals: [], flags: {} },
      { name: "@lynn/cli", version: "0.80.0", build: "old" },
      {
        stdin: ttyInput("yes\n") as never,
        stdout: stdout as never,
        stderr,
        env: {},
        check: async () => ({
          available: true,
          manifest: {
            version: "0.80.0",
            build: "new",
            tarballUrl: "https://download.example.test/lynn-cli-0.80.0.tgz",
          },
        }),
        install: async () => 1,
      },
    )).resolves.toBeUndefined();

    expect(stdout.output).toContain("正在更新 Lynn CLI");
    expect(stderr.output).toContain("当前版本不受影响");
  });
});
