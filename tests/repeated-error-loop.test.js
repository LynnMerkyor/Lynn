import { describe, expect, it } from "vitest";

import {
  buildRepeatedErrorLoopAnswer,
  detectRepeatedErrorLoop,
  extractErrorSignature,
} from "../server/chat/repeated-error-loop.js";

describe("repeated error loop detector", () => {
  const first = "跑 main.py 报：ImportError: cannot import name 'foo' from 'mymodule'。请修。";
  const second = "还是同样的报错：ImportError: cannot import name 'foo' from 'mymodule'。继续修。";
  const third = "又报：ImportError: cannot import name 'foo' from 'mymodule'。";

  it("normalizes the exception class and message instead of prompt wording", () => {
    expect(extractErrorSignature(first)).toBe("importerror:cannot import name 'foo' from 'mymodule'");
    expect(extractErrorSignature(first)).not.toBe("");
  });

  it("stops only after three consecutive matching error signatures", () => {
    const history = [
      { role: "user", content: first },
      { role: "assistant", content: "先检查。" },
      { role: "user", content: second },
      { role: "assistant", content: "继续检查。" },
    ];
    expect(detectRepeatedErrorLoop(history.slice(0, 2), second)).toBeNull();
    const loop = detectRepeatedErrorLoop(history, third);
    expect(loop).toMatchObject({ count: 3 });
    expect(buildRepeatedErrorLoopAnswer(loop)).toContain("重新规划");
    expect(buildRepeatedErrorLoopAnswer(loop)).toContain("traceback");
    expect(buildRepeatedErrorLoopAnswer(loop)).toContain("版本");
  });

  it("does not combine different exceptions into one loop", () => {
    const history = [
      { role: "user", content: first },
      { role: "user", content: "TypeError: value is not callable" },
    ];
    expect(detectRepeatedErrorLoop(history, third)).toBeNull();
  });
});
