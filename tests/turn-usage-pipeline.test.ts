// A-11 usage 管线(SDK→WS→store→StatusBar)的两端单测:
// ① server 端 extractLastAssistantUsage:从持久化会话倒序取最后一条带 Pi-SDK usage 的
//    assistant 消息,投影 + timestamp 去重锚点。
// ② renderer 端 accumulateTurnUsage:按 timestamp 去重的会话累计(重复回包绝不重复计数)。
import { describe, expect, it } from "vitest";
import { extractLastAssistantUsage } from "../server/chat/session-persistence.js";
import { accumulateTurnUsage, type TurnUsagePayload } from "../desktop/src/react/stores/usage-slice.js";

function piUsage(input: number, output: number, cacheRead = 0, costTotal = 0) {
  return {
    input, output, cacheRead, cacheWrite: 0, totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal },
  };
}

describe("extractLastAssistantUsage (server tap)", () => {
  it("returns the LAST assistant message's usage with model + timestamp", () => {
    const session = {
      messages: [
        { role: "user", content: "hi", timestamp: 1 },
        { role: "assistant", content: [], model: "step-3.7-flash", usage: piUsage(100, 20), timestamp: 2 },
        { role: "user", content: "more", timestamp: 3 },
        { role: "assistant", content: [], model: "step-3.7-flash", usage: piUsage(2788, 342, 1280, 0.0123), timestamp: 4 },
      ],
    };
    const out = extractLastAssistantUsage(session);
    expect(out).toMatchObject({
      input: 2788, output: 342, cacheRead: 1280, totalTokens: 3130,
      costTotal: 0.0123, model: "step-3.7-flash", timestamp: 4,
    });
  });

  it("skips assistant messages without usage and tolerates malformed sessions", () => {
    expect(extractLastAssistantUsage({ messages: [{ role: "assistant", content: [] }] })).toBeNull();
    expect(extractLastAssistantUsage(null)).toBeNull();
    expect(extractLastAssistantUsage({})).toBeNull();
  });
});

describe("accumulateTurnUsage (renderer dedup accumulator)", () => {
  const payload = (ts: number, input = 1000, output = 200): TurnUsagePayload => ({
    input, output, cacheRead: 400, cacheWrite: 0, totalTokens: input + output,
    costTotal: 0.01, model: "step-3.7-flash", timestamp: ts,
  });

  it("accumulates across turns", () => {
    const t1 = accumulateTurnUsage(undefined, payload(100));
    expect(t1).toMatchObject({ input: 1000, output: 200, turns: 1, lastCountedTs: 100 });
    const t2 = accumulateTurnUsage(t1!, payload(200, 2000, 300));
    expect(t2).toMatchObject({ input: 3000, output: 500, totalTokens: 3500, turns: 2, lastCountedTs: 200 });
    expect(t2!.costTotal).toBeCloseTo(0.02);
  });

  it("dedups the same assistant message (identical timestamp) — repeated context_usage replies", () => {
    const t1 = accumulateTurnUsage(undefined, payload(100));
    expect(accumulateTurnUsage(t1!, payload(100))).toBeNull();
  });
});
