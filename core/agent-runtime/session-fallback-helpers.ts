import {
  collectToolEvidence,
  evidenceToReadableLines,
  sanitizeToolEvidenceText,
} from "../../shared/evidence-safety-answer.js";
import {
  STEP_DELEGATION_TOOL_KEYS,
  contentToText,
  roleMessage,
  toolNameKey,
  type ModelFallbackReason,
} from "./session-openai-adapter.js";
import type { ChatMessage, Model } from "./types.js";

export function modelSearchText(model: Model): string {
  return [model.provider, model.id, model.name, model.api]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function modelIdentity(model: Model): string {
  return `${model.provider || ""}/${model.id || model.name || ""}`.toLowerCase();
}

export function fallbackRank(model: Model): number {
  const provider = String(model.provider || "").trim().toLowerCase();
  const id = String(model.id || "").trim().toLowerCase();
  const base = String(model.baseUrl || model.baseURL || "").trim().toLowerCase();
  const text = modelSearchText(model);
  if (
    id === "step-3.7-flash"
    || id === "step-3.7-flash-q3km-mtp-local"
    || (text.includes("step-3.7-flash") && base.includes("/step37/"))
  ) {
    return 0;
  }
  if (
    (id.includes("mimo") || text.includes("mimo") || base.includes("xiaomimimo"))
    && !/(?:asr|tts|voice)/i.test([id, text].join(" "))
  ) {
    return 10;
  }
  if (
    id === "glm-5-turbo"
    && (
      provider.includes("zhipu")
      || text.includes("glm-5-turbo")
      || base.includes("zhipu")
      || base.includes("bigmodel")
    )
  ) {
    return 20;
  }
  return Number.POSITIVE_INFINITY;
}

export function isStepExecutorModel(model: Model): boolean {
  return fallbackRank(model) === 0;
}

export function fallbackInstruction(reason: ModelFallbackReason): string {
  if (reason === "tool_round_limit") {
    return "上一模型已经完成多轮工具调用但没有形成最终回复。请只基于上面的用户问题和工具结果直接给出简明最终答案，不要再调用工具。";
  }
  if (reason === "model_error") {
    return "上一模型请求失败。请直接回答用户最后的问题；如果已有工具结果，请优先基于工具结果作答，不要再调用工具。";
  }
  return "上一模型没有返回可见正文。请直接回答用户最后的问题；如果已有工具结果，请优先基于工具结果作答，不要再调用工具。";
}

export function fallbackInstructionWithToolUse(reason: ModelFallbackReason): string {
  if (reason === "tool_round_limit") {
    return "上一模型多轮尝试后没有形成最终回复。请接管这个任务：必要时调用一次最相关工具获取证据，然后直接给出简明最终答案。";
  }
  if (reason === "model_error") {
    return "上一模型请求失败。请接管用户最后的问题：必要时调用一次最相关工具获取证据，然后直接给出简明最终答案。";
  }
  return "上一模型没有返回可见正文。请接管用户最后的问题：必要时调用一次最相关工具获取证据，然后直接给出简明最终答案。";
}

export function hasAnyToolEvidence(messages: ChatMessage[]): boolean {
  return messages.some((message) => {
    if (message.role !== "tool") return false;
    return sanitizeToolEvidenceText(contentToText(message.content)).length > 0;
  });
}

export function isStepDelegationEvidenceToolName(name: string | undefined): boolean {
  if (!name) return false;
  return STEP_DELEGATION_TOOL_KEYS.has(toolNameKey(name));
}

export function hasUsableToolEvidence(messages: ChatMessage[]): boolean {
  const evidence = collectToolEvidence(messages, 2600);
  return evidence ? evidenceToReadableLines(evidence).length > 0 : false;
}

export function toolMessageHasUsableEvidence(message: ChatMessage): boolean {
  if (message.role !== "tool") return false;
  const text = sanitizeToolEvidenceText(contentToText(message.content));
  if (!text) return false;
  const name = message.name ? ` (${message.name})` : "";
  return evidenceToReadableLines(`#1${name}\n${text}`).length > 0;
}

export function countUsableStepDelegationEvidenceToolMessages(messages: ChatMessage[]): number {
  return messages.filter((message) => {
    if (message.role !== "tool") return false;
    if (!isStepDelegationEvidenceToolName(message.name)) return false;
    return toolMessageHasUsableEvidence(message);
  }).length;
}

export function countAnyStepDelegationEvidenceToolMessages(messages: ChatMessage[]): number {
  return messages.filter((message) => {
    if (message.role !== "tool") return false;
    if (!isStepDelegationEvidenceToolName(message.name)) return false;
    return sanitizeToolEvidenceText(contentToText(message.content)).length > 0;
  }).length;
}

export function latestUserQuestion(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "user") continue;
    const text = contentToText(message.content).trim();
    if (text) return text;
  }
  return "";
}

export function hasAssistantProcessChatter(text: string): boolean {
  return /(?:我(?:先|再|来|已经)?(?:帮你|为你)?(?:查|搜索|检索|获取|拿到|确认|核对|整理|看看)|让我(?:先|再|来)?(?:查|搜索|检索|获取|拿到|确认|核对|整理|看看)|好[，,][^。\n]{0,100}(?:查|搜|获取|拿到|确认|整理)|看起来[^。\n]{0,100}(?:了|！|。)|(?:尚未|还没有|没有)[^。\n]{0,120}(?:我(?:再|来|帮你|为你)|让我))/u.test(text);
}

export function answerBoundaryOffset(matchText: string): number {
  const firstVisible = matchText.search(/[^\n\s]/);
  return firstVisible < 0 ? 0 : firstVisible;
}

export function collectAnswerBoundaryIndexes(text: string): number[] {
  const indexes: number[] = [];
  const patterns = [
    /(?:^|\n)\s*#{1,6}\s+\S/gu,
    /(?:^|\n)\s*(?:[-*]\s*)?(?:以下是|结果如下|整理如下|汇总如下|最终答案|答案如下|直接结论|结论)[：:]?/gu,
    /\n\s*\|[^\n|]+(?:\|[^\n|]+)+\|\s*\n\s*\|?[\s:：\-|]+\|/gu,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      indexes.push(match.index + answerBoundaryOffset(match[0]));
    }
  }
  return [...new Set(indexes)].sort((a, b) => a - b);
}

export function looksLikeSubstantiveAnswer(text: string): boolean {
  const compact = text.replace(/\s+/g, "");
  if (compact.length < 30) return false;
  const hasWords = /[\p{L}\p{Script=Han}]{2,}/u.test(text);
  const hasStructure = /\n|[：:。；;，,]|\|[^|\n]+\||(?:^|\n)\s*[-*]\s+/u.test(text);
  return hasWords && hasStructure;
}

export function stripAssistantProcessChatter(text: string): string {
  if (!text.trim() || /```/.test(text)) return text;
  if (!hasAssistantProcessChatter(text)) return text;
  for (const boundary of collectAnswerBoundaryIndexes(text)) {
    if (boundary <= 0) continue;
    const prefix = text.slice(0, boundary);
    const suffix = text.slice(boundary).trimStart();
    if (prefix.trim().length < 16) continue;
    if (!hasAssistantProcessChatter(prefix)) continue;
    if (!looksLikeSubstantiveAnswer(suffix)) continue;
    return suffix;
  }
  return text;
}

export function normalizeFinalAnswerText(content: string): string {
  let text = String(content || "").replace(/\r/g, "\n");
  if (!text.trim()) return text;
  const hasCodeFence = /```/.test(text);
  text = stripAssistantProcessChatter(text);
  const blocks = text.split(/\n{2,}/);
  const dedupedBlocks: string[] = [];
  let previousBlockKey = "";
  for (const block of blocks) {
    const key = block.replace(/\s+/g, "");
    if (key && key === previousBlockKey) continue;
    dedupedBlocks.push(block);
    previousBlockKey = key;
  }
  text = dedupedBlocks.join("\n\n");
  if (hasCodeFence || /\n\|.+\|\n/.test(text)) return text;

  const parts = text.split(/(?<=[。！？!?])\s*/u).filter((part) => part.length > 0);
  if (parts.length <= 1) return text;
  const recent: string[] = [];
  const out: string[] = [];
  for (const part of parts) {
    const key = part.replace(/\s+/g, "");
    if (key.length >= 14 && recent.includes(key)) continue;
    out.push(part);
    if (key.length >= 14) {
      recent.push(key);
      if (recent.length > 4) recent.shift();
    }
  }
  return out.join("").replace(/[ \t]+\n/g, "\n").trimEnd();
}

export function buildFallbackSynthesisMessages(messages: ChatMessage[], reason: ModelFallbackReason): ChatMessage[] {
  const question = latestUserQuestion(messages);
  const rawEvidence = collectToolEvidence(messages);
  const evidenceLines = evidenceToReadableLines(rawEvidence);
  const evidence = evidenceLines.map((line) => `- ${line}`).join("\n");
  const reasonText = reason === "tool_round_limit"
    ? "上一个模型已经多轮调用工具但没有产出最终答案。"
    : reason === "model_error"
      ? "上一个模型请求失败。"
      : "上一个模型没有返回可见正文。";
  return [
    roleMessage("system", [
      "你是接管总结模型。只根据用户问题和工具证据给出最终答案。",
      "不要再调用工具，不要复述内部错误，不要声称没有证据，除非工具证据确实为空。",
      "如果证据不足，明确列出已知信息和不确定点。",
    ].join("\n")),
    roleMessage("user", [
      reasonText,
      "",
      `用户问题：${question || "（未找到用户问题）"}`,
      "",
      "工具证据：",
      evidence || "（没有可用工具证据）",
      "",
      "请直接给出面向用户的简明最终答案。",
    ].join("\n")),
  ];
}

export function buildStepExecutorPolicyPrompt(): string {
  return [
    "你可以使用工具 step_execute，把明确子任务交给 Step 3.7 Flash 高速执行器。",
    "当任务已经足够明确、需要快速执行/整理/总结时，优先调用 step_execute，而不是自己继续重复搜索、抓取或长时间推理。",
    "推荐调用场景：搜索/行情/赛程/天气等工具结果已有证据后需要总结；表格/列表/代码/文档整理；长任务中的明确子步骤；你可能空答、超时或过度思考时。",
    "不要在闲聊、澄清问题、复查结论，或会修改/删除文件、执行命令、付款等有副作用的任务里自动调用 step_execute。",
    "调用时只传一个清晰可执行的 task，并把必要证据压缩进 context。",
  ].join("\n");
}

export function buildPromptUserContent(prompt: string, options?: PromptOptions): MessageContent {
  const images = Array.isArray(options?.images) ? options.images as ImageContent[] : [];
  if (!images.length) return prompt;
  const parts: Array<TextContent | ImageContent> = [{ type: "text", text: prompt }];
  for (const image of images) parts.push(image);
  return parts;
}

export async function maybeString(value: unknown): Promise<string> {
  const resolved = await value;
  return typeof resolved === "string" ? resolved : "";
}
