import fs from "node:fs";
import { describe, expect, it } from "vitest";

const component = fs.readFileSync("desktop/src/react/components/chat/ToolGroupBlock.tsx", "utf8");
const css = fs.readFileSync("desktop/src/react/components/chat/Chat.module.css", "utf8");

describe("web search sources UI", () => {
  it("renders structured source traces as a collapsible details panel", () => {
    expect(component).toContain("SearchSourcesPanel");
    expect(component).toContain("<details className={styles.searchSourcesPanel}>");
    expect(component).toContain("target=\"_blank\"");
    expect(component).toContain("rel=\"noreferrer\"");
  });

  it("ships styles for the source panel and source links", () => {
    expect(css).toContain(".searchSourcesPanel");
    expect(css).toContain(".searchSourcesSummary");
    expect(css).toContain(".searchSourceItem a");
  });
});
