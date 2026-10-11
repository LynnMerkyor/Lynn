export const LOCAL_QWEN35_PROVIDER_ID = "local-qwen35-9b-q4km-imatrix";
export const LOCAL_QWEN35_MODEL_ID = "qwen38-27b-coder390-q3-lynnstyle";

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
  "qwen38-27b-coder390-q3-lynnstyle",
  "qwen38-27b-coder390-q2-lynnstyle",
  "qwen38-27b-efficientthink-q3-lynnstyle",
  "qwen38-27b-efficientthink-q2-lynnstyle",
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
  "当前推荐本地模型为 Qwen3.8-27B Coder390 EfficientThink。16GB 默认 Q2，主模型 13.28 GB；24GB 及以上默认 Q3，主模型 17.30 GB。低于 14GiB 显存/统一内存不能安装，14～不足 16GiB 仅达 Q2 最低门槛。Apple Silicon 看统一内存，NVIDIA 看单卡显存，不叠加多卡，不把系统内存当显存。两档都是内置 Q4 MTP 的 GGUF，不另下 DFlash2，不含视觉组件。实际内存还需容纳 KV 缓存与运行缓冲。",
  "Q3 默认 8K、Q2 默认 4K 上下文，单并发；使用 llama.cpp draft-mtp。实际 TPS 需本机测量，勿套用旧模型或仓库高并发 TPS。评测及完整说明见模型卡。下列旧型号资料仅适用于对应旧型号，不代表当前模型。",
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
