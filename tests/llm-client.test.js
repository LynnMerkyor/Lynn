import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { callText } from "../shared/llm-client.js";
import { buildClientSignaturePayload, registerClientIdentityWithBrainApi } from "../shared/client-agent-identity.js";

const tempDirs = [];

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

describe("callText", () => {
  it("omits thinking payload for GLM openai-compatible requests when reasoning is off", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "OK" } }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const text = await callText({
      api: "openai-completions",
      apiKey: "sk-test",
      baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
      model: "glm-5.1",
      provider: "glm",
      messages: [{ role: "user", content: "请只回复OK" }],
      temperature: 0,
      maxTokens: 16,
      timeoutMs: 5000,
    });

    expect(text).toBe("OK");
    const [, requestInit] = fetchMock.mock.calls[0];
    const body = JSON.parse(requestInit.body);
    expect(body.thinking).toBeUndefined();
  });

  it("keeps qwen enable_thinking payload without zai thinking override", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "hello" } }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await callText({
      api: "openai-completions",
      apiKey: "sk-test",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen3.5-flash",
      provider: "dashscope",
      quirks: ["enable_thinking"],
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 5000,
    });

    const [, requestInit] = fetchMock.mock.calls[0];
    const body = JSON.parse(requestInit.body);
    expect(body.enable_thinking).toBe(false);
    expect(body.thinking).toBeUndefined();
  });

  it("extracts final text from structured OpenAI content arrays", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{
          message: {
            content: [
              { type: "reasoning", reasoning: "step by step" },
              { type: "text", text: "最终答案" },
            ],
          },
        }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const text = await callText({
      api: "openai-completions",
      apiKey: "sk-test",
      baseUrl: "https://example.com/v1",
      model: "demo-model",
      messages: [{ role: "user", content: "请只回复最终答案" }],
      timeoutMs: 5000,
    });

    expect(text).toBe("最终答案");
  });

  it("retries reasoning-only OpenAI responses with a visible-answer nudge", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          choices: [{
            message: {
              content: "",
              reasoning_content: "我需要先想一想。",
            },
          }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          choices: [{ message: { content: "最终答案" } }],
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const text = await callText({
      api: "openai-completions",
      apiKey: "sk-test",
      baseUrl: "https://example.com/v1",
      model: "demo-reasoner",
      provider: "custom-openai",
      messages: [{ role: "user", content: "ping" }],
      timeoutMs: 5000,
    });

    expect(text).toBe("最终答案");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(secondBody.messages[0]).toEqual(expect.objectContaining({
      role: "system",
      content: expect.stringContaining("最终可见答案"),
    }));
  });

  it("extracts a labeled final answer from repeated reasoning-only responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{
          message: {
            content: "",
            reasoning_content: "分析略。\n答案：可以正常回复。",
          },
        }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const text = await callText({
      api: "openai-completions",
      apiKey: "sk-test",
      baseUrl: "https://example.com/v1",
      model: "demo-reasoner",
      provider: "custom-openai",
      messages: [{ role: "user", content: "ping" }],
      timeoutMs: 5000,
    });

    expect(text).toBe("可以正常回复。");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("disables DeepSeek V4 thinking for non-stream utility calls by default", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "OK" } }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const text = await callText({
      api: "openai-completions",
      apiKey: "sk-test",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-v4-pro",
      provider: "deepseek",
      messages: [{ role: "user", content: "你好" }],
      timeoutMs: 1000,
    });

    expect(text).toBe("OK");
    const [, requestInit] = fetchMock.mock.calls[0];
    const body = JSON.parse(requestInit.body);
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("preserves DeepSeek V4 reasoning_content on follow-up requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "OK" } }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await callText({
      api: "openai-completions",
      apiKey: "sk-test",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-v4-pro-202606",
      provider: "my-deepseek-byok",
      messages: [
        { role: "user", content: "第一轮" },
        {
          role: "assistant",
          content: "第一轮可见答案",
          reasoning_content: "上一轮 DeepSeek 思考链摘要",
        },
        { role: "user", content: "继续" },
      ],
      timeoutMs: 1000,
    });

    const [, requestInit] = fetchMock.mock.calls[0];
    const body = JSON.parse(requestInit.body);
    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: "第一轮可见答案",
      reasoning_content: "上一轮 DeepSeek 思考链摘要",
    });
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("classifies non-json 403 responses as auth failures instead of invalid JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      headers: { get: () => "text/html" },
      text: async () => "<html>forbidden</html>",
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(callText({
      api: "openai-responses",
      apiKey: "sk-test",
      baseUrl: "https://example.com/v1",
      model: "demo-model",
      messages: [{ role: "user", content: "ping" }],
      timeoutMs: 1000,
    })).rejects.toMatchObject({
      code: "LLM_AUTH_FAILED",
      context: { model: "demo-model", status: 403 },
    });
  });

  it("attaches signed client identity headers from preferences.json for Brain requests", async () => {
    const lynnHome = makeTempDir("hanako-llm-");
    const clientKey = "ak_test_client_001";
    const clientSecret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    fs.mkdirSync(path.join(lynnHome, "user"), { recursive: true });
    fs.writeFileSync(
      path.join(lynnHome, "user", "preferences.json"),
      JSON.stringify({
        client_agent_key: clientKey,
        client_agent_secret: clientSecret,
      }, null, 2),
      "utf-8",
    );
    vi.stubEnv("LYNN_HOME", lynnHome);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "OK" } }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await callText({
      api: "openai-completions",
      apiKey: "sk-test",
      baseUrl: "https://api.merkyorlynn.com/api/v2/v1",
      model: "demo-model",
      provider: "brain",
      messages: [{ role: "user", content: "hello" }],
      timeoutMs: 1000,
    });

    const [, requestInit] = fetchMock.mock.calls[0];
    expect(requestInit.headers["X-Agent-Key"]).toBe(clientKey);
    expect(requestInit.headers["X-Lynn-Client-Platform"]).toBeTruthy();
    expect(requestInit.headers["X-Lynn-Timestamp"]).toBeTruthy();
    expect(requestInit.headers["X-Lynn-Nonce"]).toMatch(/^[a-f0-9]{24}$/);
    expect(requestInit.headers["X-Lynn-Signature"]).toMatch(/^v1:[a-f0-9]{64}$/);
  });

  it("does not attach Lynn client identity headers to third-party BYOK requests", async () => {
    const lynnHome = makeTempDir("hanako-llm-byok-");
    fs.mkdirSync(path.join(lynnHome, "user"), { recursive: true });
    fs.writeFileSync(
      path.join(lynnHome, "user", "preferences.json"),
      JSON.stringify({
        client_agent_key: "ak_test_client_001",
        client_agent_secret: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      }, null, 2),
      "utf-8",
    );
    vi.stubEnv("LYNN_HOME", lynnHome);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "OK" } }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await callText({
      api: "openai-completions",
      apiKey: "sk-test",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-v4-pro",
      provider: "deepseek",
      messages: [{ role: "user", content: "hello" }],
      timeoutMs: 1000,
    });

    const [, requestInit] = fetchMock.mock.calls[0];
    expect(requestInit.headers["X-Agent-Key"]).toBeUndefined();
    expect(requestInit.headers["X-Lynn-Client-Platform"]).toBeUndefined();
    expect(requestInit.headers["X-Lynn-Timestamp"]).toBeUndefined();
    expect(requestInit.headers["X-Lynn-Nonce"]).toBeUndefined();
    expect(requestInit.headers["X-Lynn-Signature"]).toBeUndefined();
  });

  it("can disable signed client identity headers for legacy diagnostics", async () => {
    const lynnHome = makeTempDir("hanako-llm-signature-");
    const clientKey = "ak_test_client_001";
    const clientSecret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    fs.mkdirSync(path.join(lynnHome, "user"), { recursive: true });
    fs.writeFileSync(
      path.join(lynnHome, "user", "preferences.json"),
      JSON.stringify({
        client_agent_key: clientKey,
        client_agent_secret: clientSecret,
      }, null, 2),
      "utf-8",
    );
    vi.stubEnv("LYNN_HOME", lynnHome);
    vi.stubEnv("LYNN_DISABLE_DEVICE_SIGNATURE", "1");

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "OK" } }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await callText({
      api: "openai-completions",
      apiKey: "sk-test",
      baseUrl: "https://api.merkyorlynn.com/api/v2/v1",
      model: "demo-model",
      provider: "brain",
      messages: [{ role: "user", content: "hello" }],
      timeoutMs: 1000,
    });

    const [, requestInit] = fetchMock.mock.calls[0];
    expect(requestInit.headers["X-Agent-Key"]).toBe(clientKey);
    expect(requestInit.headers["X-Lynn-Client-Platform"]).toBeTruthy();
    expect(requestInit.headers["X-Lynn-Timestamp"]).toBeUndefined();
    expect(requestInit.headers["X-Lynn-Nonce"]).toBeUndefined();
    expect(requestInit.headers["X-Lynn-Signature"]).toBeUndefined();
  });

  it("registers GUI client identity through the same Brain v1 device endpoint as CLI", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await registerClientIdentityWithBrainApi({
      baseUrl: "https://api.merkyorlynn.com/api/v2",
      agentKey: "ak_0123456789abcdef0123456789abcdef",
      secret: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      clientVersion: "0.80.0",
      clientPlatform: "macos",
    });

    expect(fetchMock.mock.calls[0][0]).toBe("https://api.merkyorlynn.com/api/v2/v1/devices/register");
  });

  it("normalizes GUI OpenAI-compatible signatures to the Brain v1 chat path", () => {
    const payload = buildClientSignaturePayload({
      method: "POST",
      pathname: "/chat/completions",
      timestamp: "1000",
      nonce: "abc",
      agentKey: "ak_test",
    });

    expect(payload).toContain("\nPOST\n/v1/chat/completions\n");
  });
});
