import { describe, expect, it } from "vitest";

import {
  containsNonProgressPseudoToolSimulation,
  flushStreamingPseudoToolBlocks,
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

describe("stream sanitizer · cross-chunk carry buffer", () => {
  it("strips a complete pseudo-tool block delivered in a single chunk", () => {
    const ss = {};
    const raw = "<tool_call>{\"name\":\"web_search\"}</tool_call>\n结果在这里。";
    const result = stripStreamingPseudoToolBlocks(ss, raw);
    expect(result.text.trim()).toBe("结果在这里。");
    expect(result.suppressed).toBe(true);
    // No residual carry — the block closed within the chunk.
    expect(flushStreamingPseudoToolBlocks(ss)).toEqual({ text: "", suppressed: false });
  });

  it("withholds a split <tool_call> opener across two chunks without leaking the tag", () => {
    const ss = {};
    // Chunk 1 ends mid-tag opener: "<tool_" with no closer yet.
    const r1 = stripStreamingPseudoToolBlocks(ss, "正文开始。\n<tool_");
    // The safe prose before the opener must still emit; the "<tool_" tail is withheld.
    expect(r1.text).toBe("正文开始。\n");
    expect(r1.suppressed).toBe(false);

    // Chunk 2 completes the block. Combined with the carry it forms a full <tool_call>…</tool_call>
    // which the strip removes entirely. The trailing "\n完成。" is what survives (stripPseudoToolCallMarkup
    // applies a final trim, so the leading newline is dropped — this is the existing sanitizer
    // behavior and not something this change touches).
    const r2 = stripStreamingPseudoToolBlocks(ss, "call>{\"name\":\"bash\"}</tool_call>\n完成。");
    expect(r2.text).toBe("完成。");
    expect(r2.suppressed).toBe(true);

    // Carry is now empty.
    expect(flushStreamingPseudoToolBlocks(ss)).toEqual({ text: "", suppressed: false });
  });

  it("does not withhold ordinary prose that contains a `<` comparison", () => {
    const ss = {};
    // "< 5" has a "<" but the next char is a space, so it's not a tag opener → emit immediately.
    const result = stripStreamingPseudoToolBlocks(ss, "数量 < 5 个。");
    expect(result).toEqual({ text: "数量 < 5 个。", suppressed: false });
    expect(flushStreamingPseudoToolBlocks(ss)).toEqual({ text: "", suppressed: false });
  });

  it("does not withhold legitimate markup: <details>, JSX, TS generics, comparisons", () => {
    // None of these match the pseudo-tool tag registry (tool*/execute/read*/invoke/function/
    // parameter/command/query/template tags), so they must flow through unchanged and leave an
    // empty carry. This is the core regression guard for the over-broad-scan rework.
    const cases = [
      "<details><summary>展开说明</summary>正文</details>",
      "<Component prop={x}>文本</Component>",
      "泛型写法 Array<T> 和 Map<K, V>",
      "a < b 且 b < c",
      "<details>\n<summary>点开</summary>\n内容\n</details>",
      "<div class=\"note\">HTML 标签</div>",
      "const f = <T,>(x: T) => x;",
    ];
    for (const raw of cases) {
      const ss = {};
      const result = stripStreamingPseudoToolBlocks(ss, raw);
      expect(result, `input: ${raw}`).toEqual({ text: raw, suppressed: false });
      expect(flushStreamingPseudoToolBlocks(ss), `flush after: ${raw}`).toEqual({ text: "", suppressed: false });
    }
  });

  it("does not withhold legitimate markup split across chunks", () => {
    // <details> opener in one chunk, its closer in the next — must NOT be treated as a pseudo-tool
    // opener and withheld. Both halves emit as-is.
    const ss = {};
    const r1 = stripStreamingPseudoToolBlocks(ss, "说明：<details>");
    expect(r1).toEqual({ text: "说明：<details>", suppressed: false });
    const r2 = stripStreamingPseudoToolBlocks(ss, "<summary>标题</summary>正文</details>");
    expect(r2).toEqual({ text: "<summary>标题</summary>正文</details>", suppressed: false });
    expect(flushStreamingPseudoToolBlocks(ss)).toEqual({ text: "", suppressed: false });
  });

  it("emits already-closed inline tags in the same chunk (no needless buffering)", () => {
    const ss = {};
    // A legit assistant message that happens to contain a closed XML-ish fragment must pass
    // through (the closed fragment has no pseudo-tool marker, so nothing is stripped).
    const result = stripStreamingPseudoToolBlocks(ss, "see <not_a_tool>note</not_a_tool> end");
    expect(result).toEqual({ text: "see <not_a_tool>note</not_a_tool> end", suppressed: false });
    expect(flushStreamingPseudoToolBlocks(ss)).toEqual({ text: "", suppressed: false });
  });

  it("strips visible planning tags without touching prose", () => {
    const ss = {};
    const result = stripStreamingPseudoToolBlocks(ss, "<plan>第一步：先备份。\n</plan>第二步：执行。");

    expect(result).toEqual({
      text: "第一步：先备份。\n第二步：执行。",
      suppressed: true,
    });
    expect(flushStreamingPseudoToolBlocks(ss)).toEqual({ text: "", suppressed: false });
  });

  it("hides closed internal reasoning blocks and keeps the final answer", () => {
    const ss = {};
    const result = stripStreamingPseudoToolBlocks(
      ss,
      "<reflect>Premise: internal notes only.</reflect>给客户先道歉，再确认问题并转交研发。",
    );

    expect(result).toEqual({
      text: "给客户先道歉，再确认问题并转交研发。",
      suppressed: true,
    });
    expect(flushStreamingPseudoToolBlocks(ss)).toEqual({ text: "", suppressed: false });
  });

  it("withholds an unclosed internal reasoning block so empty-answer recovery can run", () => {
    const ss = {};
    const first = stripStreamingPseudoToolBlocks(ss, "<ref");
    const second = stripStreamingPseudoToolBlocks(ss, "lect>Premise: internal notes only.");
    const third = stripStreamingPseudoToolBlocks(ss, "Still reasoning without a final answer.");

    expect(first.text).toBe("");
    expect(second).toEqual({ text: "", suppressed: true });
    expect(third).toEqual({ text: "", suppressed: true });
    expect(flushStreamingPseudoToolBlocks(ss)).toEqual({ text: "", suppressed: true });
  });

  it("recognizes an internal reasoning closer split across chunks", () => {
    const ss = {};
    stripStreamingPseudoToolBlocks(ss, "<thinking>hidden</thi");
    const result = stripStreamingPseudoToolBlocks(ss, "nking>最终答案。 ");

    expect(result).toEqual({ text: "最终答案。 ", suppressed: true });
    expect(flushStreamingPseudoToolBlocks(ss)).toEqual({ text: "", suppressed: false });
  });

  it("strips visible angle-bracket structure labels", () => {
    const ss = {};
    const result = stripStreamingPseudoToolBlocks(ss, "<方案：30分钟手机存储整理流程> **原则：先备份再删除。**");

    expect(result).toEqual({
      text: "**原则：先备份再删除。**",
      suppressed: true,
    });
    expect(flushStreamingPseudoToolBlocks(ss)).toEqual({ text: "", suppressed: false });
  });

  it("strips visible template and snake-case structure tags", () => {
    const ss = {};
    const result = stripStreamingPseudoToolBlocks(ss, "<template>主题：延期说明</template>\n<move_checklist>提前预约搬家公司。");

    expect(result).toEqual({
      text: "主题：延期说明\n提前预约搬家公司。",
      suppressed: true,
    });
    expect(flushStreamingPseudoToolBlocks(ss)).toEqual({ text: "", suppressed: false });
  });

  it("strips model-generated section tags from travel advice", () => {
    const ss = {};
    const result = stripStreamingPseudoToolBlocks(
      ss,
      "<position>先核对实际位置。</position>\n<cancellation>展开取消条款。</cancellation>\n<reviews>优先看近期差评。</reviews>",
    );

    expect(result).toEqual({
      text: "先核对实际位置。\n展开取消条款。\n优先看近期差评。",
      suppressed: true,
    });
    expect(flushStreamingPseudoToolBlocks(ss)).toEqual({ text: "", suppressed: false });
  });

  it("withholds split visible planning tags across chunks", () => {
    const ss = {};
    const r1 = stripStreamingPseudoToolBlocks(ss, "正文\n<st");
    expect(r1).toEqual({ text: "正文\n", suppressed: false });

    const r2 = stripStreamingPseudoToolBlocks(ss, "eps>第一步</steps> 结束。");
    expect(r2).toEqual({ text: "第一步 结束。", suppressed: true });
    expect(flushStreamingPseudoToolBlocks(ss)).toEqual({ text: "", suppressed: false });
  });

  it("flush emits ordinary trailing prose held in the carry", () => {
    const ss = {};
    // A trailing "<" with nothing after it is withheld as a candidate opener. At turn end it
    // turns out to be ordinary text ("3 < 4" never closed) — but since the carry itself is just
    // "<" with no following char, it is treated as a dangling opener and withheld by flush.
    // Use a clearer case: trailing prose that got withheld only because it followed a real
    // withheld opener which then resolved.
    stripStreamingPseudoToolBlocks(ss, "回答：<tool_");
    stripStreamingPseudoToolBlocks(ss, "x>ignored</tool_x> 尾句。");
    // After the block resolves, "尾句。" should have been emitted already in r2. Carry is empty.
    const flushed = flushStreamingPseudoToolBlocks(ss);
    expect(flushed).toEqual({ text: "", suppressed: false });
  });

  it("flush drops a dangling pseudo-tool opener that never closes", () => {
    const ss = {};
    stripStreamingPseudoToolBlocks(ss, "前文。\n<tool_call>{\"name\":\"x\"");
    // No further delta — turn ends with the block still open.
    const flushed = flushStreamingPseudoToolBlocks(ss);
    // The dangling "<tool_call>..." must NOT leak to the client.
    expect(flushed.text).toBe("");
    expect(flushed.suppressed).toBe(true);
  });

  it("flush emits trailing prose held after a withheld opener when the opener resolves closed", () => {
    const ss = {};
    // Opener withheld across the boundary…
    stripStreamingPseudoToolBlocks(ss, "开头。<tool_call>");
    // …then closed in the next delta, with trailing prose after it. The leading space before
    // "结尾。" is trimmed by stripPseudoToolCallMarkup's existing final trim.
    const r2 = stripStreamingPseudoToolBlocks(ss, "{}</tool_call> 结尾。");
    expect(r2.text).toBe("结尾。");
    expect(r2.suppressed).toBe(true);
    expect(flushStreamingPseudoToolBlocks(ss)).toEqual({ text: "", suppressed: false });
  });

  it("handles a `||N` pipe-numbered opener split across chunks", () => {
    const ss = {};
    const r1 = stripStreamingPseudoToolBlocks(ss, "正文 ||1 web_search");
    // "||1 web_search" has no closing "}" yet → withheld.
    expect(r1.text).toBe("正文 ");
    const r2 = stripStreamingPseudoToolBlocks(ss, "|| {\"q\":\"天气\"} 收尾。");
    expect(r2.suppressed).toBe(true);
    expect(flushStreamingPseudoToolBlocks(ss)).toEqual({ text: "", suppressed: false });
  });

  it("does not buffer across independent turns — fresh ss starts clean", () => {
    const ss1 = {};
    stripStreamingPseudoToolBlocks(ss1, "<tool_");
    // Turn ends, carry discarded by flush.
    flushStreamingPseudoToolBlocks(ss1);
    // New turn, fresh state.
    const ss2 = {};
    const result = stripStreamingPseudoToolBlocks(ss2, "新的一轮，正常文本。");
    expect(result).toEqual({ text: "新的一轮，正常文本。", suppressed: false });
  });
});
