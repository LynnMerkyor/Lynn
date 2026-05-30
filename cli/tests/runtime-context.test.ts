import { describe, expect, it } from "vitest";
import {
  buildCliRuntimeSystemMessage,
  refreshCliRuntimeSystemMessage,
  resetCliRuntimeMessages,
} from "../src/runtime-context.js";

describe("CLI runtime context", () => {
  it("tells the model which route the user sees", () => {
    const message = buildCliRuntimeSystemMessage("MiMo V2.5 Pro → StepFun 3.7 Flash via Brain router (auto)");

    expect(message.role).toBe("system");
    expect(message.content).toContain("Current model route shown to the user: MiMo V2.5 Pro");
    expect(message.content).toContain("default online route is MiMo V2.5 Pro first");
    expect(message.content).toContain("answer from this runtime context");
  });

  it("refreshes the system route without moving it out of the prefix", () => {
    const messages = resetCliRuntimeMessages("MiMo V2.5 Pro → StepFun 3.7 Flash");
    messages.push({ role: "user", content: "hi" });

    refreshCliRuntimeSystemMessage(messages, "CLI BYOK: step-3.7-flash");

    expect(messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("CLI BYOK: step-3.7-flash"),
    });
    expect(messages[1]).toEqual({ role: "user", content: "hi" });
  });
});
