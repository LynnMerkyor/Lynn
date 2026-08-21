import { describe, expect, it } from "vitest";

import { createBrowserTool } from "../lib/tools/browser-tool.js";
import { createWebFetchTool } from "../lib/tools/web-fetch.js";

describe("tool error contract", () => {
  it("marks an empty web_fetch URL as a failed tool result", async () => {
    const result = await createWebFetchTool().execute("fetch-empty", { url: "" });

    expect(result.isError).toBe(true);
  });

  it("marks an unknown browser action as a failed tool result", async () => {
    const result = await createBrowserTool().execute("browser-unknown", { action: "unknown" });

    expect(result.isError).toBe(true);
  });
});
