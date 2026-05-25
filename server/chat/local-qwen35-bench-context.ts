export const LOCAL_QWEN35_PROVIDER_ID = "local-qwen35-9b-q4km-imatrix";
export const LOCAL_QWEN35_MODEL_ID = "qwen35-9b-q4km-imatrix";

export interface LocalQwenModelInfo {
  provider?: unknown;
  modelId?: unknown;
  id?: unknown;
  [key: string]: unknown;
}

export const LOCAL_QWEN_COMPAT_PROVIDER_IDS = new Set<string>([
  "local-qwen35-4b-q4km",
  "local-qwen3-4b-thinking-2507-q4km-imatrix",
  "local-qwen35-9b-q4km-imatrix",
]);

export const LOCAL_QWEN_COMPAT_MODEL_IDS = new Set<string>([
  "qwen35-4b-q4km",
  "qwen3-4b-thinking-2507-q4km-imatrix",
  "qwen35-9b-q4km-imatrix",
  "qwen36-35b-a3b-q4km-imatrix",
]);

const LOCAL_QWEN35_BENCHMARK_MARKER = "【Lynn 本地模型事实备忘】";

export const LOCAL_QWEN35_BENCHMARK_CONTEXT = [
  LOCAL_QWEN35_BENCHMARK_MARKER,
  "当前默认本地模型是 Qwen3.5-9B Q4_K_M imatrix MTP,经 llama.cpp 运行；5.38GB,24GB 显存/统一内存推荐,thinking-on 稳定性和工具调用强于 4B。4B imatrix 只作为低配降级档,必须提示 thinking-on 可能长思考后无正文。",
  "Qwen3.5-9B Q4_K_M imatrix MTP (默认档,24GB+) thinking-on 32K: MMLU 100 sample = 81.00%, GPQA Diamond full = 72.22% naive / 81.71% excluding parse-fail, tool-call gate 修正后约 14/15 = 93%。GB10 Spark TPS: think-off 1024 = 46.16 tok/s, think-on 4096 = 77.46 tok/s, think-on 32K sustained = 78.32 tok/s。",
  "Qwen3.5-4B Q4_K_M imatrix (低配降级档): 2026-05-24 由官方 BF16 重新转换并用 256-chunk imatrix 校准量化；直连 smoke: thinking-off 短问候正常、门禁工具调用正常；thinking-on 短问候/GPQA probe 可能长思考后无正文,所以 4B 不应作为默认引导模型。",
  "Qwen3.6-35B-A3B Q4_K_M imatrix (高端档,24GB+,21GB) thinking-on 32K: MMLU 500 = 90.40%, GPQA Diamond = 80.70%。Lynn imatrix 校准版,R6000 参考 207 tok/s;24G 本地机加载需注意上下文长度,长上下文建议保留 32G+ 内存余量。本变体不含 MTP 加速,纯 Q4_K_M 推理。",
].join("\n");

export function isLocalQwen35Model(modelInfo: LocalQwenModelInfo | null | undefined = {}): boolean {
  const provider = String(modelInfo?.provider || "").toLowerCase();
  const modelId = String(modelInfo?.modelId || modelInfo?.id || "").toLowerCase();
  return LOCAL_QWEN_COMPAT_PROVIDER_IDS.has(provider) && LOCAL_QWEN_COMPAT_MODEL_IDS.has(modelId);
}

export function shouldAttachLocalQwen35BenchContext(promptText: unknown = "", modelInfo: LocalQwenModelInfo | null | undefined = {}): boolean {
  if (!isLocalQwen35Model(modelInfo)) return false;
  const text = String(promptText || "");
  if (!/(qwen3|4b|9b|35b|本地模型|本地\s*(4b|9b|35b)|自己|你的|你自己|量化|q4[_-]?k[_-]?m|nvfp4|w4a16|bf16|tool|工具)/i.test(text)) return false;
  return /(?:mmlu|gpqa|gqpa|成绩|分数|测评|benchmark|bench|评测|能力|tool.?call|工具调用|thinking|思考|量化)/i.test(text);
}

export function attachLocalQwen35BenchContext(promptText: unknown = "", modelInfo: LocalQwenModelInfo | null | undefined = {}): string {
  const text = String(promptText || "");
  if (text.includes(LOCAL_QWEN35_BENCHMARK_MARKER)) return text;
  if (!shouldAttachLocalQwen35BenchContext(text, modelInfo)) return text;
  return `${LOCAL_QWEN35_BENCHMARK_CONTEXT}\n\n${text}`;
}
