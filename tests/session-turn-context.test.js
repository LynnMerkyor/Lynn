import { describe, expect, it, vi } from "vitest";
import {
  clearSessionTurnContext,
  prepareSessionTurnContext,
} from "../core/session-turn-context.js";

describe("session turn context helpers", () => {
  it("prepares recall, route, skill, at-file, and turn instruction context", async () => {
    const entry = {
      session: {
        sessionManager: { getCwd: () => "/tmp/workspace" },
      },
    };
    const agent = {
      recallForMessage: vi.fn(async () => "remembered facts"),
    };
    const routeAroundBrokenToolModel = vi.fn();

    await prepareSessionTurnContext({
      entry,
      text: "请修改 app.ts 修复这个 bug",
      agent,
      imagesCount: 0,
      turnInstruction: "reply briefly",
      locale: "zh-CN",
      getSkills: () => ({
        suggestSkillsForText: () => [{ name: "ts-fix", description: "TypeScript fix" }],
      }),
      routeAroundBrokenToolModel,
    });

    expect(agent.recallForMessage).toHaveBeenCalledWith("请修改 app.ts 修复这个 bug", "/tmp/workspace");
    expect(entry._lastRecallContext).toBe("remembered facts");
    expect(entry._routeIntentValue).toBe("coding");
    expect(typeof entry._routeIntentHintContext).toBe("string");
    expect(typeof entry._scenarioContractHintContext).toBe("string");
    expect(entry._lastSkillHintContext).toContain("ts-fix");
    expect(entry._atInjectionHintContext).toContain("@app.ts");
    expect(entry._turnInstructionHintContext).toBe("reply briefly");
    expect(routeAroundBrokenToolModel).toHaveBeenCalledWith("coding");
  });

  it("stores injected recall fact ids when recall returns structured context", async () => {
    const entry = {
      session: {
        sessionManager: { getCwd: () => "/tmp/workspace" },
      },
    };
    const agent = {
      recallForMessage: vi.fn(async () => ({
        text: "remembered facts",
        injectedFactIds: [1, "2", 1],
      })),
    };

    await prepareSessionTurnContext({
      entry,
      text: "继续修 React streaming",
      agent,
      locale: "zh-CN",
    });

    expect(entry._lastRecallContext).toBe("remembered facts");
    expect(entry._lastRecallFactIds).toEqual(["1", "2"]);
  });

  it("clears transient context after a turn", () => {
    const entry = {
      _lastRecallContext: "memory",
      _lastRecallFactIds: ["1"],
      _memoryOutcomeToolFailureRecorded: true,
      _lastSkillHintContext: "skill",
      _atInjectionHintContext: "at",
      _turnInstructionHintContext: "instruction",
      _routeIntentHintContext: "route",
      _scenarioContractHintContext: "scenario",
      _routeIntentValue: "coding",
    };

    clearSessionTurnContext(entry);

    expect(entry).toMatchObject({
      _lastRecallContext: "",
      _lastRecallFactIds: [],
      _memoryOutcomeToolFailureRecorded: false,
      _lastSkillHintContext: "",
      _atInjectionHintContext: "",
      _turnInstructionHintContext: "",
      _routeIntentHintContext: "",
      _scenarioContractHintContext: "",
      _routeIntentValue: "chat",
    });
  });
});
