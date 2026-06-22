import { describe, expect, it } from "vitest";
import {
  mergeSessionTopology,
  normalizeSessionTopology,
} from "../session-topology.js";

describe("session topology metadata", () => {
  it("normalizes branch metadata for long conversation recovery", () => {
    const topology = normalizeSessionTopology({
      parent: " /tmp/parent.jsonl ",
      root: "/tmp/root.jsonl",
      label: " V0.85.1 memory ",
      status: "paused",
      summary: " release target ".repeat(20),
      resume: "continue from topology",
      createdAt: "2026-06-22T00:00:00.000Z",
    });

    expect(topology).toMatchObject({
      parentSessionPath: "/tmp/parent.jsonl",
      rootSessionPath: "/tmp/root.jsonl",
      branchLabel: "V0.85.1 memory",
      taskStatus: "paused",
      resumeHint: "continue from topology",
      createdAt: "2026-06-22T00:00:00.000Z",
    });
  });

  it("returns null for empty active metadata", () => {
    expect(normalizeSessionTopology({ status: "active" })).toBeNull();
  });

  it("merges partial updates without losing the existing branch", () => {
    const merged = mergeSessionTopology(
      { branchLabel: "Search quality", taskStatus: "active", createdAt: "2026-06-22T01:00:00.000Z" },
      { resumeHint: "Use evidence gate before fallback", status: "paused" },
      new Date("2026-06-22T02:00:00.000Z"),
    );

    expect(merged).toMatchObject({
      branchLabel: "Search quality",
      taskStatus: "paused",
      resumeHint: "Use evidence gate before fallback",
      createdAt: "2026-06-22T01:00:00.000Z",
      updatedAt: "2026-06-22T02:00:00.000Z",
    });
  });
});
