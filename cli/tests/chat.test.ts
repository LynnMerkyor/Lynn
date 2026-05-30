import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import {
  applyModeCommand,
  applyReasoningCommand,
  buildChatProviderArgs,
  chatRouteLabel,
  completeChatInput,
  formatChatError,
  isModeToggleKeypress,
  renderMode,
  renderOfflineChatHint,
  resolveChatMode,
  shouldRefreshProviderRoute,
  shouldShowProviderSetUsage,
  splitChatCommandLine,
  toggleMode,
} from "../src/commands/chat.js";
import { BrainConnectionError } from "../src/brain-client.js";
import { setLang } from "../src/i18n.js";

const cliRoot = fileURLToPath(new URL("..", import.meta.url));

beforeEach(() => setLang("en"));
afterEach(() => setLang(null));

describe("chat mode controls", () => {
  it("toggles between guarded and yolo modes", () => {
    const mode = { approval: "ask" as const, sandbox: "workspace-write" as const };

    expect(renderMode(mode)).toBe("ask / workspace-write");
    expect(applyModeCommand(mode, "yolo")).toBe("YOLO mode enabled.");
    expect(renderMode(mode)).toBe("yolo / danger-full-access");
    expect(applyModeCommand(mode, "ask")).toBe("Guarded mode enabled.");
    expect(renderMode(mode)).toBe("ask / workspace-write");
  });

  it("supports the Shift+Tab hotkey shape used by terminals", () => {
    expect(isModeToggleKeypress({ sequence: "\u001b[Z" })).toBe(true);
    expect(isModeToggleKeypress({ name: "tab", shift: true })).toBe(true);
    expect(isModeToggleKeypress({ name: "tab" })).toBe(false);
  });

  it("toggles yolo mode with the hotkey action", () => {
    const mode = { approval: "ask" as const, sandbox: "workspace-write" as const };

    expect(toggleMode(mode)).toBe("YOLO mode enabled.");
    expect(renderMode(mode)).toBe("yolo / danger-full-access");
    expect(toggleMode(mode)).toBe("Guarded mode enabled.");
    expect(renderMode(mode)).toBe("ask / workspace-write");
  });

  it("uses the shared CLI/client permission profile for chat startup mode", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-chat-perms-"));
    try {
      await fs.mkdir(path.join(dataDir, "permissions"), { recursive: true });
      await fs.writeFile(
        path.join(dataDir, "permissions", "cli.json"),
        JSON.stringify({ approval: "yolo", sandbox: "danger-full-access" }),
        "utf8",
      );

      const mode = await resolveChatMode(parseArgs(["chat", "--data-dir", dataDir]));

      expect(renderMode(mode)).toBe("yolo / danger-full-access");
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("localizes mode command receipts and danger warning", () => {
    setLang("zh");
    const mode = { approval: "ask" as const, sandbox: "workspace-write" as const };

    expect(applyModeCommand(mode, "yolo")).toContain("YOLO 模式");
    expect(applyModeCommand(mode, "wat")).toContain("未知权限模式");
  });

  it("renders a short Brain recovery message for interactive chat", () => {
    const message = formatChatError(new BrainConnectionError("http://127.0.0.1:8790", new Error("fetch failed")));

    expect(message).toContain("local Brain is offline");
    expect(message).toContain("CLI-only BYOK");
    expect(message).not.toContain("For CLI-only smoke tests");
  });

  it("renders a one-shot offline hint for bare startup", () => {
    const hint = renderOfflineChatHint({ approval: "ask", sandbox: "workspace-write" }, "http://127.0.0.1:8790");

    expect(hint).toContain("local Brain offline");
    expect(hint).toContain("CLI-only BYOK");
    expect(hint).toContain("lynn providers");
    expect(hint).toContain("--mock-brain");
  });

  it("renders CLI BYOK as usable when Brain is offline", () => {
    const hint = renderOfflineChatHint(
      { approval: "ask", sandbox: "workspace-write" },
      "http://127.0.0.1:8790",
      { provider: "openai-compatible", model: "deepseek-chat" },
    );

    expect(hint).toContain("using CLI BYOK provider directly");
    expect(hint).toContain("deepseek-chat");
  });

  it("surfaces CLI BYOK fallback in the chat startup route label", () => {
    expect(chatRouteLabel({ provider: "openai-compatible", model: "step-3.7-flash" })).toBe("CLI BYOK: step-3.7-flash");
    expect(chatRouteLabel(null)).toBe("MiMo via Brain router (auto)");
  });

  it("renders CLI BYOK fallback in startup copy", () => {
    setLang("zh");
    const provider = { provider: "openai-compatible", model: "step-3.7-flash" };
    const hint = renderOfflineChatHint({ approval: "ask", sandbox: "workspace-write" }, "http://127.0.0.1:8790", provider);

    expect(chatRouteLabel(provider)).toContain("step-3.7-flash");
    expect(hint).toContain("step-3.7-flash");
  });

  it("updates reasoning mode for fast and deep MiMo turns", () => {
    const current = { effort: "auto" as const, display: "auto" as const };

    expect(applyReasoningCommand(current, "off").reasoning).toMatchObject({ effort: "off" });
    expect(applyReasoningCommand(current, "high").reasoning).toMatchObject({ effort: "high" });
    expect(applyReasoningCommand(current, "show").reasoning).toMatchObject({ display: "always" });
  });

  it("localizes reasoning command receipts", () => {
    setLang("zh");
    const current = { effort: "auto" as const, display: "auto" as const };

    expect(applyReasoningCommand(current, "high").message).toContain("推理强度");
    expect(applyReasoningCommand(current, "show").message).toContain("始终");
  });

  it("offers slash completion in chat mode", () => {
    expect(completeChatInput("/prov")).toEqual([
      ["/providers", "/providers set", "/providers unset", "/providers test", "/providers presets"],
      "/prov",
    ]);
    expect(completeChatInput("/providers s")).toEqual([["/providers set"], "/providers s"]);
    expect(completeChatInput("/")).toMatchObject([
      expect.arrayContaining(["/help", "/mode", "/providers", "/byok"]),
      "/",
    ]);
    expect(completeChatInput("hello")).toEqual([[], "hello"]);
  });

  it("splits chat provider commands with quoted values", () => {
    expect(splitChatCommandLine('/providers set --base-url "https://api.example.com/v1" --model "step-3.7-flash"')).toEqual([
      "/providers",
      "set",
      "--base-url",
      "https://api.example.com/v1",
      "--model",
      "step-3.7-flash",
    ]);
    expect(splitChatCommandLine("/providers set --api-key sk\\ test")).toEqual([
      "/providers",
      "set",
      "--api-key",
      "sk test",
    ]);
  });

  it("builds provider subcommands from chat without losing data-dir", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-chat-provider-"));
    try {
      const base = parseArgs(["chat", "--data-dir", dataDir]);
      const command = buildChatProviderArgs("/providers set --preset stepfun --api-key step-key", base);

      expect(command?.command).toBe("providers");
      expect(command?.positionals).toEqual(["set"]);
      expect(command?.flags["preset"]).toBe("stepfun");
      expect(command?.flags["api-key"]).toBe("step-key");
      expect(command?.flags["data-dir"]).toBe(dataDir);
      expect(shouldRefreshProviderRoute(command!)).toBe(true);
      expect(shouldShowProviderSetUsage(command!)).toBe(false);
      expect(shouldShowProviderSetUsage(buildChatProviderArgs("/providers set", base)!)).toBe(true);
      expect(buildChatProviderArgs("/providers wat", base)).toBeNull();
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("runs interactive chat through CLI BYOK when Brain is offline", async () => {
    let requestBody = "";
    const provider = http.createServer((request, response) => {
      expect(request.url).toBe("/v1/chat/completions");
      expect(request.headers.authorization).toBe("Bearer sk-chat-test");
      request.on("data", (chunk) => {
        requestBody += String(chunk);
      });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end([
          "data: {\"choices\":[{\"delta\":{\"content\":\"chat byok ok\"}}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":3,\"total_tokens\":6}}",
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
        "chat",
        "--brain-url",
        "http://127.0.0.1:1",
        "--base-url",
        `http://127.0.0.1:${address.port}/v1`,
        "--api-key",
        "sk-chat-test",
        "--model",
        "chat-model",
      ], {
        cwd: cliRoot,
        env: { ...process.env, NO_COLOR: "1", LYNN_LANG: "en" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("interactive chat did not exit"));
      }, 5000);
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
      child.stdin.write("hi\n/exit\n");
      child.stdin.end();
    });
    await new Promise<void>((resolve) => provider.close(() => resolve()));

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("chat byok ok");
    expect(result.stderr).toContain("route:  fallback: brain(offline) -> cli-byok:openai-compatible");
    expect(result.stderr).toContain("6 tokens");
    expect(JSON.parse(requestBody)).toMatchObject({
      model: "chat-model",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
  });
});
