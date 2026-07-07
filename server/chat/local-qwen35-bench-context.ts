export const LOCAL_QWEN35_PROVIDER_ID = "local-qwen35-9b-q4km-imatrix";
export const LOCAL_QWEN35_MODEL_ID = "qwen36-27b-dsv4pro-coding-q4-mtp";

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
  "qwen36-27b-dsv4pro-coding-q4-mtp",
  "qwen36-35b-a3b-q4km-imatrix",
  "qwen36-35b-a3b-apex-mtp",
  "qwen36-35b-a3b-dsv4pro-distill-q4km-imatrix",
  "qwen36-35b-a3b-dsv4pro-distill-q5km-imatrix",
  "local-a3b-distill",
]);

const LOCAL_QWEN35_BENCHMARK_MARKER = "【Lynn 本地模型事实备忘】";

export const LOCAL_QWEN35_BENCHMARK_CONTEXT = [
  LOCAL_QWEN35_BENCHMARK_MARKER,
  "当前默认本地模型是 Qwen3.6-27B DSV4Pro GLM52-SFT-GPT55-RL Coding GGUF Q4 imatrix MTP,经 llama.cpp 运行；4 个主分片合计约 19.6GB,24GB 显存/统一内存推荐。9B / 4B 只作为低配降级档。",
  "Qwen3.6-27B DSV4Pro Coding Q4 imatrix MTP (推荐本地档,24GB+) 32K: Coding100 82/100,LBC100 71/100；优先面向代码、Agent 和日常本地问答。",
  "Qwen3.5-9B Q4_K_M imatrix MTP (低配降级档,16~24GB 可选) thinking-on 32K: MMLU 100 sample = 81.00%, GPQA Diamond full = 72.22% naive / 81.71% excluding parse-fail, tool-call gate 修正后约 14/15 = 93%。DGX Spark MTP 单流 TPS: no-MTP AR = 36.61, MTP n_max=4 = 60.95,server TPS = 64.20,accept = 64.15%。",
  "Qwen3.5-4B Q4_K_M imatrix (低配降级档): 2026-05-24 由官方 BF16 重新转换并用 256-chunk imatrix 校准量化；直连 smoke: thinking-off 短问候正常、门禁工具调用正常；thinking-on 短问候/GPQA probe 可能长思考后无正文,所以 4B 不应作为默认引导模型。",
  "Qwen3.6-35B-A3B DSV4Pro Thinking Distill Q5_K_M imatrix MTP (高端编排器档,32GB+,25.3GB) thinking-on: GPQA-Diamond 80.3%,端到端编排约 26.6s；适合 32GB+ 配置作为更强本地编排器。",
].join("\n");

export function isLocalQwen35Model(modelInfo: LocalQwenModelInfo | null | undefined = {}): boolean {
  const provider = String(modelInfo?.provider || "").toLowerCase();
  const modelId = String(modelInfo?.modelId || modelInfo?.id || "").toLowerCase();
  return LOCAL_QWEN_COMPAT_PROVIDER_IDS.has(provider) && LOCAL_QWEN_COMPAT_MODEL_IDS.has(modelId);
}

export function shouldAttachLocalQwen35BenchContext(promptText: unknown = "", modelInfo: LocalQwenModelInfo | null | undefined = {}): boolean {
  if (!isLocalQwen35Model(modelInfo)) return false;
  const text = String(promptText || "");
  if (!/(qwen3|4b|9b|27b|35b|本地模型|本地\s*(4b|9b|27b|35b)|自己|你的|你自己|量化|q4[_-]?k[_-]?m|q5[_-]?k[_-]?m|nvfp4|w4a16|bf16|tool|工具)/i.test(text)) return false;
  return /(?:mmlu|gpqa|gqpa|成绩|分数|测评|benchmark|bench|评测|能力|tool.?call|工具调用|thinking|思考|量化)/i.test(text);
}

export function attachLocalQwen35BenchContext(promptText: unknown = "", modelInfo: LocalQwenModelInfo | null | undefined = {}): string {
  const text = String(promptText || "");
  if (text.includes(LOCAL_QWEN35_BENCHMARK_MARKER)) return text;
  if (!shouldAttachLocalQwen35BenchContext(text, modelInfo)) return text;
  return `${LOCAL_QWEN35_BENCHMARK_CONTEXT}\n\n${text}`;
}
