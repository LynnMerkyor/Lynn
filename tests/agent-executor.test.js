import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createAgentSessionMock, sessionManagerCreateMock, settingsManagerInMemoryMock } = vi.hoisted(() => ({
  createAgentSessionMock: vi.fn(),
  sessionManagerCreateMock: vi.fn(),
  settingsManagerInMemoryMock: vi.fn(() => ({})),
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  createAgentSession: createAgentSessionMock,
  SessionManager: {
    create: sessionManagerCreateMock,
    open: vi.fn(),
  },
  SettingsManager: {
    inMemory: settingsManagerInMemoryMock,
  },
}));

const { runAgentSession } = await import("../hub/agent-executor.js");

describe("runAgentSession", () => {
  let tmpDir;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-agent-exec-"));
    sessionManagerCreateMock.mockImplementation(() => ({
      getSessionFile: () => path.join(tmpDir, "session.jsonl"),
    }));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("aborts a hung prompt when the caller signal aborts", async () => {
    const abort = vi.fn(async () => {});
    const prompt = vi.fn(() => new Promise(() => {}));
    const subscribe = vi.fn(() => () => {});

    createAgentSessionMock.mockResolvedValue({
      session: {
        prompt,
        abort,
        subscribe,
        sessionManager: {
          getSessionFile: () => path.join(tmpDir, "session.jsonl"),
        },
      },
    });

    const controller = new AbortController();
    const promise = runAgentSession(
      "lynn",
      [{ text: "hello", capture: true }],
      {
        signal: controller.signal,
        engine: {
          homeCwd: tmpDir,
          getAgent: () => ({
            agentDir: path.join(tmpDir, "agents", "lynn"),
            personality: "personality",
            systemPrompt: "prompt",
            tools: [],
            config: {},
          }),
          createSessionContext: () => ({
            resourceLoader: {
              getSystemPrompt: () => "prompt",
            },
            getSkillsForAgent: () => [],
            buildTools: () => ({ tools: [], customTools: [] }),
            authStorage: {},
            modelRegistry: {},
            resolveModel: () => ({ id: "glm-5.1", provider: "glm", name: "GLM-5.1" }),
          }),
        },
      },
    );

    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("uses modelOverride when provided", async () => {
    const prompt = vi.fn(async () => {});
    const subscribe = vi.fn(() => () => {});

    createAgentSessionMock.mockResolvedValue({
      session: {
        prompt,
        abort: vi.fn(async () => {}),
        subscribe,
        sessionManager: {
          getSessionFile: () => path.join(tmpDir, "session.jsonl"),
        },
      },
    });

    const overrideModel = { id: "step-3.5-flash-2603", provider: "brain", name: "Step 3.5 Flash 2603" };

    await runAgentSession(
      "lynn",
      [{ text: "hello", capture: true }],
      {
        engine: {
          homeCwd: tmpDir,
          currentModel: { id: "glm-5.1", provider: "glm", name: "GLM-5.1" },
          getAgent: () => ({
            agentDir: path.join(tmpDir, "agents", "lynn"),
            personality: "personality",
            systemPrompt: "prompt",
            tools: [],
            config: {},
          }),
          createSessionContext: () => ({
            resourceLoader: {
              getSystemPrompt: () => "prompt",
            },
            getSkillsForAgent: () => [],
            buildTools: () => ({ tools: [], customTools: [] }),
            authStorage: {},
            modelRegistry: {},
            resolveModel: () => ({ id: "glm-5.1", provider: "glm", name: "GLM-5.1" }),
          }),
        },
        modelOverride: overrideModel,
      },
    );

    expect(createAgentSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      model: overrideModel,
    }));
  });

  it("caps the resolved model output budget when maxTokens is provided", async () => {
    const prompt = vi.fn(async () => {});
    const subscribe = vi.fn(() => () => {});

    createAgentSessionMock.mockResolvedValue({
      session: {
        prompt,
        abort: vi.fn(async () => {}),
        subscribe,
        sessionManager: {
          getSessionFile: () => path.join(tmpDir, "session.jsonl"),
        },
      },
    });

    await runAgentSession(
      "hanako",
      [{ text: "review briefly", capture: true }],
      {
        maxTokens: 1200,
        engine: {
          homeCwd: tmpDir,
          getAgent: () => ({
            agentDir: path.join(tmpDir, "agents", "hanako"),
            personality: "personality",
            systemPrompt: "prompt",
            tools: [],
            config: {},
          }),
          createSessionContext: () => ({
            resourceLoader: {
              getSystemPrompt: () => "prompt",
            },
            getSkillsForAgent: () => [],
            buildTools: () => ({ tools: [], customTools: [] }),
            authStorage: {},
            modelRegistry: {},
            resolveModel: () => ({
              id: "mimo-v2.5-pro",
              provider: "mimo",
              name: "MiMo v2.5 Pro",
              maxTokens: 64000,
            }),
          }),
        },
      },
    );

    expect(createAgentSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      model: expect.objectContaining({
        id: "mimo-v2.5-pro",
        provider: "mimo",
        maxTokens: 1200,
      }),
    }));
  });

  it("passes an explicit thinking level into the agent session", async () => {
    const prompt = vi.fn(async () => {});
    const subscribe = vi.fn(() => () => {});

    createAgentSessionMock.mockResolvedValue({
      session: {
        prompt,
        abort: vi.fn(async () => {}),
        subscribe,
        sessionManager: {
          getSessionFile: () => path.join(tmpDir, "session.jsonl"),
        },
      },
    });

    await runAgentSession(
      "hanako",
      [{ text: "review without thinking-only output", capture: true }],
      {
        thinkingLevel: "off",
        engine: {
          homeCwd: tmpDir,
          getAgent: () => ({
            agentDir: path.join(tmpDir, "agents", "hanako"),
            personality: "personality",
            systemPrompt: "prompt",
            tools: [],
            config: {},
          }),
          createSessionContext: () => ({
            resourceLoader: {
              getSystemPrompt: () => "prompt",
            },
            getSkillsForAgent: () => [],
            buildTools: () => ({ tools: [], customTools: [] }),
            authStorage: {},
            modelRegistry: {},
            resolveModel: () => ({ id: "glm-5.1", provider: "glm", name: "GLM-5.1" }),
          }),
        },
      },
    );

    expect(createAgentSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      thinkingLevel: "off",
    }));
  });

  it("lazy-loads a missing agent before executing the session", async () => {
    const prompt = vi.fn(async () => {});
    const subscribe = vi.fn(() => () => {});

    createAgentSessionMock.mockResolvedValue({
      session: {
        prompt,
        abort: vi.fn(async () => {}),
        subscribe,
        sessionManager: {
          getSessionFile: () => path.join(tmpDir, "session.jsonl"),
        },
      },
    });

    let runtimeReady = false;
    const ensureAgentLoaded = vi.fn(async () => {
      runtimeReady = true;
      return {
        agentDir: path.join(tmpDir, "agents", "hanako"),
        personality: "personality",
        systemPrompt: "prompt",
        tools: [],
        config: {},
      };
    });

    await runAgentSession(
      "hanako",
      [{ text: "hello", capture: true }],
      {
        engine: {
          homeCwd: tmpDir,
          ensureAgentLoaded,
          getAgent: () => runtimeReady ? ({
            agentDir: path.join(tmpDir, "agents", "hanako"),
            personality: "personality",
            systemPrompt: "prompt",
            tools: [],
            config: {},
          }) : null,
          createSessionContext: () => ({
            resourceLoader: {
              getSystemPrompt: () => "prompt",
            },
            getSkillsForAgent: () => [],
            buildTools: () => ({ tools: [], customTools: [] }),
            authStorage: {},
            modelRegistry: {},
            resolveModel: () => ({ id: "glm-5.1", provider: "glm", name: "GLM-5.1" }),
          }),
        },
      },
    );

    expect(ensureAgentLoaded).toHaveBeenCalledWith("hanako");
    expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the captured round assistant message when text deltas are missing", async () => {
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const messages = [
      { role: "assistant", content: "old review should not be reused" },
    ];
    const prompt = vi.fn(async () => {
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: "final review from session state" }],
      });
    });
    const subscribe = vi.fn(() => () => {});

    createAgentSessionMock.mockResolvedValue({
      session: {
        messages,
        prompt,
        abort: vi.fn(async () => {}),
        subscribe,
        sessionManager: {
          getSessionFile: () => sessionFile,
        },
      },
    });

    const result = await runAgentSession(
      "hanako",
      [{ text: "review", capture: true }],
      {
        keepSession: true,
        engine: {
          homeCwd: tmpDir,
          getAgent: () => ({
            agentDir: path.join(tmpDir, "agents", "hanako"),
            personality: "personality",
            systemPrompt: "prompt",
            tools: [],
            config: {},
          }),
          createSessionContext: () => ({
            resourceLoader: {
              getSystemPrompt: () => "prompt",
            },
            getSkillsForAgent: () => [],
            buildTools: () => ({ tools: [], customTools: [] }),
            authStorage: {},
            modelRegistry: {},
            resolveModel: () => ({ id: "glm-5.1", provider: "glm", name: "GLM-5.1" }),
          }),
        },
      },
    );

    expect(result).toBe("final review from session state");
  });

  it("waits for assistant end events that arrive just after prompt resolves", async () => {
    const sessionFile = path.join(tmpDir, "session.jsonl");
    let listener;
    const prompt = vi.fn(async () => {
      setTimeout(() => {
        listener?.({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "late review from message_end" }],
          },
        });
      }, 10);
    });
    const subscribe = vi.fn((fn) => {
      listener = fn;
      return () => {};
    });

    createAgentSessionMock.mockResolvedValue({
      session: {
        prompt,
        abort: vi.fn(async () => {}),
        subscribe,
        sessionManager: {
          getSessionFile: () => sessionFile,
        },
      },
    });

    const result = await runAgentSession(
      "hanako",
      [{ text: "review", capture: true }],
      {
        keepSession: true,
        engine: {
          homeCwd: tmpDir,
          getAgent: () => ({
            agentDir: path.join(tmpDir, "agents", "hanako"),
            personality: "personality",
            systemPrompt: "prompt",
            tools: [],
            config: {},
          }),
          createSessionContext: () => ({
            resourceLoader: {
              getSystemPrompt: () => "prompt",
            },
            getSkillsForAgent: () => [],
            buildTools: () => ({ tools: [], customTools: [] }),
            authStorage: {},
            modelRegistry: {},
            resolveModel: () => ({ id: "glm-5.1", provider: "glm", name: "GLM-5.1" }),
          }),
        },
      },
    );

    expect(result).toBe("late review from message_end");
  });

  it("keeps waiting when empty end events arrive before captured assistant text", async () => {
    const sessionFile = path.join(tmpDir, "session.jsonl");
    let listener;
    const prompt = vi.fn(async () => {
      setTimeout(() => {
        listener?.({
          type: "agent_end",
          messages: [
            { role: "assistant", content: "" },
          ],
        });
      }, 5);
      setTimeout(() => {
        listener?.({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "review after empty end event" }],
          },
        });
      }, 25);
    });
    const subscribe = vi.fn((fn) => {
      listener = fn;
      return () => {};
    });

    createAgentSessionMock.mockResolvedValue({
      session: {
        prompt,
        abort: vi.fn(async () => {}),
        subscribe,
        sessionManager: {
          getSessionFile: () => sessionFile,
        },
      },
    });

    const result = await runAgentSession(
      "hanako",
      [{ text: "review", capture: true }],
      {
        keepSession: true,
        engine: {
          homeCwd: tmpDir,
          getAgent: () => ({
            agentDir: path.join(tmpDir, "agents", "hanako"),
            personality: "personality",
            systemPrompt: "prompt",
            tools: [],
            config: {},
          }),
          createSessionContext: () => ({
            resourceLoader: {
              getSystemPrompt: () => "prompt",
            },
            getSkillsForAgent: () => [],
            buildTools: () => ({ tools: [], customTools: [] }),
            authStorage: {},
            modelRegistry: {},
            resolveModel: () => ({ id: "glm-5.1", provider: "glm", name: "GLM-5.1" }),
          }),
        },
      },
    );

    expect(result).toBe("review after empty end event");
  });

  it("falls back to the captured round jsonl assistant message when text deltas are missing", async () => {
    const sessionFile = path.join(tmpDir, "session.jsonl");
    fs.writeFileSync(sessionFile, JSON.stringify({
      role: "assistant",
      content: "old jsonl review should not be reused",
    }) + "\n");
    const prompt = vi.fn(async () => {
      fs.appendFileSync(sessionFile, JSON.stringify({
        message: {
          role: "assistant",
          content: [{ type: "text", text: "final review from jsonl" }],
        },
      }) + "\n");
    });
    const subscribe = vi.fn(() => () => {});

    createAgentSessionMock.mockResolvedValue({
      session: {
        prompt,
        abort: vi.fn(async () => {}),
        subscribe,
        sessionManager: {
          getSessionFile: () => sessionFile,
        },
      },
    });

    const result = await runAgentSession(
      "hanako",
      [{ text: "review", capture: true }],
      {
        keepSession: true,
        engine: {
          homeCwd: tmpDir,
          getAgent: () => ({
            agentDir: path.join(tmpDir, "agents", "hanako"),
            personality: "personality",
            systemPrompt: "prompt",
            tools: [],
            config: {},
          }),
          createSessionContext: () => ({
            resourceLoader: {
              getSystemPrompt: () => "prompt",
            },
            getSkillsForAgent: () => [],
            buildTools: () => ({ tools: [], customTools: [] }),
            authStorage: {},
            modelRegistry: {},
            resolveModel: () => ({ id: "glm-5.1", provider: "glm", name: "GLM-5.1" }),
          }),
        },
      },
    );

    expect(result).toBe("final review from jsonl");
  });

  it("does not reuse stale assistant text when the captured round produces no output", async () => {
    const sessionFile = path.join(tmpDir, "session.jsonl");
    fs.writeFileSync(sessionFile, JSON.stringify({
      role: "assistant",
      content: "old jsonl review should not be reused",
    }) + "\n");
    const messages = [
      { role: "assistant", content: "old review should not be reused" },
    ];
    const prompt = vi.fn(async () => {});
    const subscribe = vi.fn(() => () => {});

    createAgentSessionMock.mockResolvedValue({
      session: {
        messages,
        prompt,
        abort: vi.fn(async () => {}),
        subscribe,
        sessionManager: {
          getSessionFile: () => sessionFile,
        },
      },
    });

    const result = await runAgentSession(
      "hanako",
      [{ text: "review", capture: true }],
      {
        keepSession: true,
        engine: {
          homeCwd: tmpDir,
          getAgent: () => ({
            agentDir: path.join(tmpDir, "agents", "hanako"),
            personality: "personality",
            systemPrompt: "prompt",
            tools: [],
            config: {},
          }),
          createSessionContext: () => ({
            resourceLoader: {
              getSystemPrompt: () => "prompt",
            },
            getSkillsForAgent: () => [],
            buildTools: () => ({ tools: [], customTools: [] }),
            authStorage: {},
            modelRegistry: {},
            resolveModel: () => ({ id: "glm-5.1", provider: "glm", name: "GLM-5.1" }),
          }),
        },
      },
    );

    expect(result).toBe("");
  });
});
