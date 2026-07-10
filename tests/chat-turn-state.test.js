import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareChatTurnState, resetCompletedTurnState } from "../server/chat/stream-state.js";
import { createChatTurnState } from "../server/chat/turn-state.js";

describe("chat turn state boundaries", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts a clean turn without losing pending mutation confirmation", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T08:00:00Z"));
    const ss = createChatTurnState();
    const pendingMutationContext = {
      originalPrompt: "delete build output",
      requirement: { action: "delete" },
      recordedAt: Date.now() - 1_000,
    };

    ss.hasToolCall = true;
    ss.hasRealtimeEvidenceToolCall = true;
    ss.hasPrefetchToolCall = true;
    ss.hasLocalPrefetchEvidence = true;
    ss.activeToolCallCount = 3;
    ss.activeToolCallStartedAt = Date.now() - 500;
    ss.successfulToolCount = 2;
    ss.lastSuccessfulTools = [{ name: "read_file", summary: "old result" }];
    ss.hasFailedTool = true;
    ss.lastFailedTools = ["web_search"];
    ss.toolStormGuard = {
      total: 8,
      evidenceTotal: 4,
      byName: { web_search: 8 },
      bySignature: { stale: 8 },
      lastDecisionReason: "storm",
    };
    ss.toolStormClosed = true;
    ss.emittedFileOutputPaths.add("/tmp/old.txt");
    ss.recoveredArtifactKeys.add("old-artifact");
    ss.sanitizerCarry = "stale partial tag";
    ss.visibleTextAcc = "previous answer";
    ss.internalRetryCounts = { empty: 2 };
    ss.internalRetryPending = true;
    ss.rehydratedThisTurn = true;
    ss.postRehydrateEscalationAttempted = true;
    ss._rehydratedEffectivePrompt = "old retry prompt";
    ss.autoReviewStarted = true;
    ss.pendingMutationContext = pendingMutationContext;
    ss.__slowToolTimers = new Map([["old-tool", setTimeout(() => {}, 60_000)]]);
    ss.silentBrainAbortTimer = setTimeout(() => {}, 60_000);

    prepareChatTurnState(ss, {
      promptText: "what is in this folder?",
      routeIntent: "workspace",
      persistedAssistantTextBaseline: 21,
      persistedAssistantMessageBaseline: 4,
    });

    expect(ss.pendingMutationContext).toBe(pendingMutationContext);
    expect(ss.originalPromptText).toBe("what is in this folder?");
    expect(ss.effectivePromptText).toBe("what is in this folder?");
    expect(ss.routeIntent).toBe("workspace");
    expect(ss.persistedAssistantTextBaseline).toBe(21);
    expect(ss.persistedAssistantMessageBaseline).toBe(4);
    expect(ss.lastActivity).toBe(Date.now());

    expect(ss.hasToolCall).toBe(false);
    expect(ss.hasRealtimeEvidenceToolCall).toBe(false);
    expect(ss.hasPrefetchToolCall).toBe(false);
    expect(ss.hasLocalPrefetchEvidence).toBe(false);
    expect(ss.activeToolCallCount).toBe(0);
    expect(ss.successfulToolCount).toBe(0);
    expect(ss.lastSuccessfulTools).toEqual([]);
    expect(ss.hasFailedTool).toBe(false);
    expect(ss.lastFailedTools).toEqual([]);
    expect(ss.toolStormGuard.total).toBe(0);
    expect(ss.toolStormClosed).toBe(false);
    expect(ss.emittedFileOutputPaths.size).toBe(0);
    expect(ss.recoveredArtifactKeys.size).toBe(0);
    expect(ss.sanitizerCarry).toBe("");
    expect(ss.visibleTextAcc).toBe("");
    expect(ss.internalRetryCounts).toEqual({});
    expect(ss.internalRetryPending).toBe(false);
    expect(ss.rehydratedThisTurn).toBe(false);
    expect(ss.postRehydrateEscalationAttempted).toBe(false);
    expect(ss._rehydratedEffectivePrompt).toBeNull();
    expect(ss.autoReviewStarted).toBe(false);
    expect(ss.__slowToolTimers.size).toBe(0);
    expect(ss.silentBrainAbortTimer).toBeNull();
  });

  it("clears evidence and parser carry after a completed turn", () => {
    const ss = createChatTurnState();
    ss.hasPrefetchToolCall = true;
    ss.hasRealtimeEvidenceToolCall = true;
    ss.sanitizerCarry = "partial";
    ss.recoveredArtifactKeys.add("artifact");
    ss.emittedFileOutputPaths.add("/tmp/result.md");

    resetCompletedTurnState(ss);

    expect(ss.hasPrefetchToolCall).toBe(false);
    expect(ss.hasRealtimeEvidenceToolCall).toBe(false);
    expect(ss.sanitizerCarry).toBe("");
    expect(ss.recoveredArtifactKeys.size).toBe(0);
    expect(ss.emittedFileOutputPaths.size).toBe(0);
  });
});
