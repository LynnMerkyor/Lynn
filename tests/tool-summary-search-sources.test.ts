import { describe, expect, it } from "vitest";
import { summarizeToolExecution } from "../server/chat/tool-summary";

describe("tool summary search sources", () => {
  it("keeps web_search summary and source traces available for the UI", () => {
    const result = summarizeToolExecution({
      toolName: "web_search",
      result: {
        details: {
          provider: "lynn-brain/mimo",
          summary: "综合答案",
          sources: [
            {
              name: "mimo",
              ok: true,
              summary: "MiMo 摘要",
              items: [
                { title: "来源一", url: "https://example.com/a", snippet: "片段一" },
              ],
            },
            {
              name: "zhipu",
              ok: false,
              error: "quota exceeded",
              items: [],
            },
          ],
        },
        content: [{ type: "text", text: "搜索结果正文" }],
      },
    });

    expect(result.publicSummary?.outputPreview).toContain("搜索结果正文");
    expect(result.publicSummary?.searchProvider).toBe("lynn-brain/mimo");
    expect(result.publicSummary?.searchSummary).toBe("综合答案");
    expect(result.publicSummary?.searchSources).toHaveLength(2);
    expect(result.publicSummary?.searchSources?.[0].items?.[0]).toEqual({
      title: "来源一",
      url: "https://example.com/a",
      snippet: "片段一",
    });
    expect(result.publicSummary?.searchSources?.[1].error).toBe("quota exceeded");
  });

  it("clips oversized source fields before broadcasting tool summaries", () => {
    const longText = "x".repeat(1000);
    const result = summarizeToolExecution({
      toolName: "web_search",
      result: {
        details: {
          provider: longText,
          summary: longText,
          sources: [
            {
              name: longText,
              ok: true,
              summary: longText,
              items: [{ title: longText, url: `https://example.com/${longText}`, snippet: longText }],
            },
          ],
        },
        content: [{ type: "text", text: "ok" }],
      },
    });

    expect(result.publicSummary?.searchProvider?.length).toBeLessThanOrEqual(80);
    expect(result.publicSummary?.searchSummary?.length).toBeLessThanOrEqual(800);
    expect(result.publicSummary?.searchSources?.[0].name?.length).toBeLessThanOrEqual(48);
    expect(result.publicSummary?.searchSources?.[0].summary?.length).toBeLessThanOrEqual(360);
    expect(result.publicSummary?.searchSources?.[0].items?.[0].url?.length).toBeLessThanOrEqual(400);
  });
});
