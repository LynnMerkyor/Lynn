import { describe, expect, it } from "vitest";

import {
  buildEmptyReplyFallbackText,
  buildEmptyReplyRetryPrompt,
  buildLocalMutationContinuationRetryPrompt,
  buildLocalToolSuccessFallback,
  buildPostRehydrateEscalationPrompt,
  buildShortLeadInRetryPrompt,
  buildSuccessfulToolNoTextFallback,
  buildTruncatedStructuredRetryPrompt,
  clearPendingMutationOnSuccessfulDelete,
  commandLooksLikeDelete,
  consumeMutationConfirmation,
  looksLikeTruncatedStructuredAnswer,
  recordPendingDeleteRequest,
  shouldRetryUnverifiedLocalMutation,
  stripRouteMetadataLeaks,
} from "../server/chat/turn-retry-policy.js";

describe("turn retry policy", () => {
  it("does not synthesize fallback answers", () => {
    expect(buildEmptyReplyFallbackText({ originalPromptText: "今天金价" })).toBe("");
    expect(buildLocalToolSuccessFallback({ lastSuccessfulTools: [{ name: "bash" }] })).toBe("");
    expect(buildSuccessfulToolNoTextFallback({ lastSuccessfulTools: [{ name: "weather" }] })).toBe("");
  });

  it("does not build hidden recovery prompts", () => {
    expect(buildEmptyReplyRetryPrompt("今天金价", "utility")).toBe("今天金价");
    expect(buildShortLeadInRetryPrompt("今天金价", "我来查")).toBe("今天金价");
    expect(buildTruncatedStructuredRetryPrompt("算增长率", "|---|")).toBe("算增长率");
    expect(buildLocalMutationContinuationRetryPrompt("整理桌面", "准备执行")).toBe("整理桌面");
    expect(buildPostRehydrateEscalationPrompt("删除下载里的 zip")).toBe("删除下载里的 zip");
  });

  it("does not detect model output as a reason to retry", () => {
    expect(looksLikeTruncatedStructuredAnswer("|---|", "<reflect>long</reflect>")).toBe(false);
    expect(shouldRetryUnverifiedLocalMutation({
      hasToolCall: true,
      originalPromptText: "整理桌面",
      lastSuccessfulTools: [{ name: "bash", command: "ls" }],
    }, "已经整理")).toBe(false);
  });

  it("passes route-looking model text through unchanged", () => {
    const text = "这是回答正文。\n类型: utility\nRoute: research";
    expect(stripRouteMetadataLeaks(text)).toBe(text);
  });

  it("consumeMutationConfirmation returns the original request without an escalated recovery prompt", () => {
    const ss = {
      pendingMutationContext: {
        originalPrompt: "请把下载文件夹的所有后缀 zip 的文件都删除",
        requirement: { requiresDelete: true },
        recordedAt: Date.now(),
      },
    };

    const result = consumeMutationConfirmation(ss, "确认删除");

    expect(result).toBeTruthy();
    expect(result.originalPrompt).toBe("请把下载文件夹的所有后缀 zip 的文件都删除");
    expect(result.retryPrompt).toBe("请把下载文件夹的所有后缀 zip 的文件都删除");
    expect(result.retryPrompt).not.toContain("严格执行要求");
    expect(ss.pendingMutationContext).toBeNull();
  });

  it("consumeMutationConfirmation accepts strong-semantic confirmation phrases", () => {
    for (const phrase of ["确认删除", "确认执行", "执行删除", "继续执行", "yes", "y", "Confirm Delete", "ok", "okay", "go ahead", "proceed", "do it"]) {
      const ss = {
        pendingMutationContext: {
          originalPrompt: "删除下载里的 zip",
          requirement: { requiresDelete: true },
          recordedAt: Date.now(),
        },
      };
      const result = consumeMutationConfirmation(ss, phrase);
      expect(result, `phrase="${phrase}"`).toBeTruthy();
      expect(result.originalPrompt).toBe("删除下载里的 zip");
    }
  });

  it("consumeMutationConfirmation rejects ambiguous Chinese phrases", () => {
    for (const phrase of ["好的", "好", "是", "是的", "对", "可以", "确认", "继续", "执行", "好的。", "嗯"]) {
      const ss = {
        pendingMutationContext: {
          originalPrompt: "删除下载里的 zip",
          requirement: { requiresDelete: true },
          recordedAt: Date.now(),
        },
      };
      const result = consumeMutationConfirmation(ss, phrase);
      expect(result, `ambiguous phrase="${phrase}" must NOT auto-confirm delete`).toBeNull();
      expect(ss.pendingMutationContext).toBeTruthy();
    }
  });

  it("consumeMutationConfirmation rejects unrelated or expired input", () => {
    const ss = {
      pendingMutationContext: {
        originalPrompt: "删除下载里的 zip",
        requirement: { requiresDelete: true },
        recordedAt: Date.now(),
      },
    };

    expect(consumeMutationConfirmation(ss, "再想想")).toBeNull();
    expect(consumeMutationConfirmation(ss, "")).toBeNull();
    expect(ss.pendingMutationContext).toBeTruthy();

    const expired = {
      pendingMutationContext: {
        originalPrompt: "删除下载里的 zip",
        requirement: { requiresDelete: true },
        recordedAt: Date.now() - 30 * 60 * 1000,
      },
    };
    expect(consumeMutationConfirmation(expired, "确认删除")).toBeNull();
    expect(expired.pendingMutationContext).toBeNull();
  });

  it("recordPendingDeleteRequest only stores delete prompts", () => {
    const ss = {};
    expect(recordPendingDeleteRequest(ss, "请把下载文件夹的所有 zip 文件删除")).toBe(true);
    expect(ss.pendingMutationContext?.requirement?.requiresDelete).toBe(true);
    expect(recordPendingDeleteRequest({}, "把桌面截图移动到下载文件夹")).toBe(false);
  });

  it("clearPendingMutationOnSuccessfulDelete clears context for rm/trash/delete commands", () => {
    for (const command of [
      "rm -f /tmp/foo.zip",
      "rm -rf /tmp/lynn-bug-test/*.zip",
      "trash ~/Downloads/old.zip",
      "find ~/Downloads -name '*.zip' -delete",
    ]) {
      const ss = {
        pendingMutationContext: {
          originalPrompt: "删除下载里的 zip",
          requirement: { requiresDelete: true },
          recordedAt: Date.now(),
        },
      };
      expect(clearPendingMutationOnSuccessfulDelete(ss, command), `command="${command}"`).toBe(true);
      expect(ss.pendingMutationContext).toBeNull();
    }
  });

  it("commandLooksLikeDelete recognises delete forms only", () => {
    expect(commandLooksLikeDelete("rm -rf /tmp/x")).toBe(true);
    expect(commandLooksLikeDelete("trash ~/Downloads/old.zip")).toBe(true);
    expect(commandLooksLikeDelete("find . -name '*.tmp' -delete")).toBe(true);
    expect(commandLooksLikeDelete("ls -la")).toBe(false);
    expect(commandLooksLikeDelete("find /tmp -name '*.zip'")).toBe(false);
    expect(commandLooksLikeDelete("")).toBe(false);
  });
});
