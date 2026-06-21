import { describe, expect, it } from "vitest";
import {
  providerRouteLabel,
  providerRouteTitle,
} from "../desktop/src/react/components/chat/AssistantMessage.helpers.ts";

describe("assistant message provider route helpers", () => {
  it("shows only the final answering model in the visible label", () => {
    expect(providerRouteLabel({
      activeProvider: "step-3.7-flash",
      fallbackFrom: [{ id: "deepseek-v4-flash", reason: "planner" }],
    })).toBe("Step 3.7 Flash");
  });

  it("keeps long fallback chains out of the visible label", () => {
    expect(providerRouteLabel({
      activeProvider: "glm-5-turbo",
      fallbackFrom: [
        { id: "deepseek-v4-flash", reason: "planner" },
        { id: "step-3.7-flash", reason: "executor" },
        { id: "apex-spark-i-balanced", reason: "fallback" },
      ],
    })).toBe("GLM 5.0 Turbo");
  });

  it("keeps the full chain in the hover title for debugging", () => {
    const title = providerRouteTitle({
      activeProvider: "glm-5-turbo",
      fallbackFrom: [
        { id: "deepseek-v4-flash", reason: "planner" },
        { id: "step-3.7-flash", reason: "executor" },
        { id: "apex-spark-i-balanced", reason: "fallback" },
      ],
    });

    expect(title).toContain("完整链路：DS V4 Flash -> Step 3.7 Flash -> Spark -> GLM 5.0 Turbo");
    expect(title).toContain("Spark: fallback");
  });
});
