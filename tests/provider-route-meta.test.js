import { describe, expect, it } from "vitest";
import {
  extractProviderRouteMeta,
  normalizeProviderFallbackHop,
} from "../server/chat/provider-route-meta.js";

describe("provider route metadata helpers", () => {
  it("normalizes lynn.provider SSE metadata", () => {
    expect(extractProviderRouteMeta({
      object: "lynn.provider",
      meta: {
        active_provider: "apex-spark-i-balanced",
        fallback_from: [
          { id: "mimo", reason: "cooldown" },
          { providerId: "local", error: "probe-failed" },
        ],
      },
    })).toEqual({
      activeProvider: "apex-spark-i-balanced",
      fallbackFrom: [
        { id: "mimo", reason: "cooldown" },
        { id: "local", reason: "probe-failed" },
      ],
    });
  });

  it("normalizes provider_meta websocket-shaped events", () => {
    expect(extractProviderRouteMeta({
      type: "provider_meta",
      activeProvider: "spark",
      fallbackFrom: [{ provider: "mimo", status: "probe-threw" }],
    })).toEqual({
      activeProvider: "spark",
      fallbackFrom: [{ id: "mimo", reason: "probe-threw" }],
    });
  });

  it("normalizes provider metadata nested in message_update events", () => {
    expect(extractProviderRouteMeta({
      type: "message_update",
      assistantMessageEvent: {
        type: "provider_update",
        meta: {
          active_provider: "deepseek",
          fallback_from: [{ name: "spark", reason: "empty" }],
        },
      },
    })).toEqual({
      activeProvider: "deepseek",
      fallbackFrom: [{ id: "spark", reason: "empty" }],
    });
  });

  it("ignores non-provider events and malformed fallback hops", () => {
    expect(extractProviderRouteMeta({ type: "message_update", assistantMessageEvent: { type: "text_delta" } })).toBeNull();
    expect(normalizeProviderFallbackHop({ reason: "cooldown" })).toBeNull();
  });
});
