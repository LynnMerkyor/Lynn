import { describe, expect, it } from "vitest";
import {
  BRAIN_MANAGED_CUSTOM_TOOLS,
  filterOutBrainManagedCustomTools,
  isBrainManagedCustomToolName,
} from "../core/brain-managed-tools.ts";

describe("brain managed tools registry", () => {
  it("keeps the shared Brain-managed tool registry as the single source of truth", () => {
    expect(isBrainManagedCustomToolName("web_search")).toBe(true);
    expect(isBrainManagedCustomToolName("web-search")).toBe(true);
    expect(isBrainManagedCustomToolName("sports-score")).toBe(true);
    expect(isBrainManagedCustomToolName(" web_fetch ")).toBe(true);
    expect(isBrainManagedCustomToolName("todo")).toBe(false);
    expect(BRAIN_MANAGED_CUSTOM_TOOLS.has("stock_market")).toBe(true);
  });

  it("filters Brain-managed custom tools without mutating non-Brain tools", () => {
    const tools = [
      { name: "web_search" },
      { name: "web-search" },
      { name: "todo" },
      { name: "stock_market" },
      { name: "create_report" },
    ];

    expect(filterOutBrainManagedCustomTools(tools).map((tool) => tool.name)).toEqual([
      "todo",
      "create_report",
    ]);
  });
});
