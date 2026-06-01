// ============================================================================
// 对抗式自检(#4)—— 不换大模型,让同一个模型在收尾前当「严格的怀疑者」独立复核一次。
//
// 收尾门(已过自动验证 + 计划契约)后,用一段全新的、对抗性的上下文(只给任务 + 拟交付答案,
// 不带原对话的乐观惯性)逼模型找自己的茬。独立视角能逮住一部分"无症状的自信错误"——正是
// flash 模型最危险的失败模式。封顶 1 次,成本就一个额外模型调用。
// ============================================================================

// Opt-in: this is the only guard that costs an extra model call (and can add a turn)
// on every mutating task, so it defaults OFF — turn it on for complex/critical work.
export function selfVerifyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LYNN_CLI_SELF_VERIFY === "1";
}

export function buildSelfVerifyPrompt(task: string, proposedAnswer: string): string {
  return [
    "You are a STRICT adversarial reviewer of work that was just completed. Be skeptical, not agreeable — your job is to find what is wrong, not to approve.",
    "",
    `TASK:\n${task}`,
    "",
    `PROPOSED FINAL ANSWER / RESULT:\n${proposedAnswer || "(no text was produced)"}`,
    "",
    "Critically check the ACTUAL work, not the confidence behind it:",
    "- Did it truly accomplish every part of the task, or only appear to?",
    "- Any bug, missing step, unhandled edge case, wrong assumption, or claim that was not actually verified?",
    "- Were the right things edited, or could a change be incomplete or in the wrong place?",
    "",
    "If — and only if — the work is genuinely complete and correct, reply with exactly this line and nothing else:",
    "VERDICT: PASS",
    "Otherwise reply with:",
    "VERDICT: ISSUES",
    "followed by a numbered list of the specific, concrete problems that must be fixed.",
  ].join("\n");
}

export interface SelfVerifyVerdict {
  pass: boolean;
  issues: string;
}

/** Parse the reviewer's verdict. Passes ONLY on an explicit PASS; anything else is treated as issues. */
export function parseSelfVerifyVerdict(text: string): SelfVerifyVerdict {
  const upper = text.toUpperCase();
  const passIdx = upper.lastIndexOf("VERDICT: PASS");
  const issuesIdx = upper.lastIndexOf("VERDICT: ISSUES");
  if (passIdx >= 0 && passIdx > issuesIdx) return { pass: true, issues: "" };
  const issues = issuesIdx >= 0 ? text.slice(issuesIdx + "VERDICT: ISSUES".length).trim() : text.trim();
  return { pass: false, issues: issues || "Self-review was inconclusive — re-verify the work against the task before finishing." };
}

export function formatSelfVerifyCritique(issues: string): string {
  return [
    "⚠ Adversarial self-review found problems to fix before you can finish:",
    issues,
    "Address each point above (make the edits + re-verify), then give the final answer.",
  ].join("\n");
}
