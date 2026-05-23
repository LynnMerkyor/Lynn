import { describe, expect, it } from "vitest";

import {
  containsNonProgressPseudoToolSimulation,
  stripStreamingPseudoToolBlocks,
} from "../server/chat/stream-sanitizer.js";

describe("stream sanitizer pass-through", () => {
  it("passes plain text through unchanged", () => {
    expect(stripStreamingPseudoToolBlocks({}, "普通回答，没有内部标签。")).toEqual({
      text: "普通回答，没有内部标签。",
      suppressed: false,
    });
  });

  it("passes pseudo-tool-looking text through unchanged", () => {
    const raw = "</think>\n<|tool_code_begin|>bash\nfind ~/Downloads -name '*.zip'\n<|tool_code_end|>\n完成。";
    expect(stripStreamingPseudoToolBlocks({}, raw)).toEqual({
      text: raw,
      suppressed: false,
    });
  });

  it("does not flag pseudo-tool-looking text as non-progress simulation", () => {
    expect(containsNonProgressPseudoToolSimulation(
      '<lynn_tool_progress event="start" name="web_search"></lynn_tool_progress><web_search>深圳天气</web_search>',
    )).toBe(false);
  });
});
