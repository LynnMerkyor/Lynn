import { describe, expect, it } from "vitest";

import {
  containsNonProgressPseudoToolSimulation,
  stripStreamingPseudoToolBlocks,
} from "../server/chat/stream-sanitizer.js";

describe("stream sanitizer", () => {
  it("passes plain text through unchanged", () => {
    expect(stripStreamingPseudoToolBlocks({}, "普通回答，没有内部标签。")).toEqual({
      text: "普通回答，没有内部标签。",
      suppressed: false,
    });
  });

  it("normalizes nullish chunks to an empty pass-through string", () => {
    expect(stripStreamingPseudoToolBlocks({}, null)).toEqual({
      text: "",
      suppressed: false,
    });
  });

  it("strips high-confidence pseudo-tool-looking text", () => {
    const raw = "</think>\n<|tool_code_begin|>bash\nfind ~/Downloads -name '*.zip'\n<|tool_code_end|>\n完成。";
    const result = stripStreamingPseudoToolBlocks({}, raw);
    expect(result.suppressed).toBe(true);
    expect(result.text).toBe("完成。");
  });

  it("flags pseudo-tool-looking text as non-progress simulation", () => {
    expect(containsNonProgressPseudoToolSimulation(
      '<lynn_tool_progress event="start" name="web_search"></lynn_tool_progress><web_search>深圳天气</web_search>',
    )).toBe(true);
  });
});
