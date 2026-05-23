export const LOCAL_QWEN35_PROVIDER_ID = "local-qwen35-9b-q4km-imatrix";
export const LOCAL_QWEN35_MODEL_ID = "qwen35-9b-q4km-imatrix";

export const LOCAL_QWEN_COMPAT_PROVIDER_IDS = new Set([
  "local-qwen3-4b-thinking-2507-q4km-imatrix",
  "local-qwen35-9b-q4km-imatrix",
]);

export const LOCAL_QWEN_COMPAT_MODEL_IDS = new Set([
  "qwen3-4b-thinking-2507-q4km-imatrix",
  "qwen35-9b-q4km-imatrix",
  "qwen36-35b-a3b-q4km-imatrix",
]);

const LOCAL_QWEN35_BENCHMARK_MARKER = "【Lynn 本地模型事实备忘】";

export const LOCAL_QWEN35_BENCHMARK_CONTEXT = [
  LOCAL_QWEN35_BENCHMARK_MARKER,
  "当前默认本地模型是 Qwen3.5-9B Q4_K_M imatrix MTP，经 llama.cpp 运行；35B APEX-MTP 是 24GB+ 高端可选档。",
  "如果用户询问“你/本地模型/9B/35B 的 MMLU、GPQA/GQPA、量化、工具调用、thinking-on/off 测评”，优先使用下面的 Lynn hard data；只有用户明确要查外部资料时才需要联网。",
  "9B MTP thinking-on 32K 口径：Q4_K_M imatrix MTP = MMLU 100 sample 81.00%，GPQA Diamond full/sweep 约 72.22% naive / 81.71% excluding parse-fail；tool-call gate 修正后约 14/15 = 93%，release smoke 7/7 PASS。",
  "9B MTP GB10 Spark TPS：think-off 1024 = 46.16 tok/s，think-off 2048 sustained = 43.81 tok/s，think-on 4096 = 77.46 tok/s，think-on 16K = 69.00 tok/s，think-on 32K sustained = 78.32 tok/s。",
  "35B APEX-MTP thinking-on 32K 口径：MMLU 500 = 90.40%，GPQA Diamond = 80.70%；GB10 Spark TPS：think-off 1024 = 59.70 tok/s，think-off 2048 = 61.95 tok/s，think-on 4K = 84.69 tok/s，think-on 16K = 75.53 tok/s。35B 短答 think-off 不建议默认开 MTP，长思考建议 MTP。",
  "回答时请明确区分 sample size、thinking-on/off、naive 与 excluding parse-fail，不要把样本口径混成同一个数字。",
].join("\n");

export function isLocalQwen35Model(modelInfo = {}) {
  const provider = String(modelInfo?.provider || "").toLowerCase();
  const modelId = String(modelInfo?.modelId || modelInfo?.id || "").toLowerCase();
  return LOCAL_QWEN_COMPAT_PROVIDER_IDS.has(provider) && LOCAL_QWEN_COMPAT_MODEL_IDS.has(modelId);
}

export function shouldAttachLocalQwen35BenchContext(promptText = "", modelInfo = {}) {
  if (!isLocalQwen35Model(modelInfo)) return false;
  const text = String(promptText || "");
  if (!/(qwen3|4b|9b|35b|本地模型|本地\s*(4b|9b|35b)|自己|你的|你自己|量化|q4[_-]?k[_-]?m|nvfp4|w4a16|bf16|tool|工具)/i.test(text)) return false;
  return /(?:mmlu|gpqa|gqpa|成绩|分数|测评|benchmark|bench|评测|能力|tool.?call|工具调用|thinking|思考|量化)/i.test(text);
}

export function attachLocalQwen35BenchContext(promptText = "", modelInfo = {}) {
  const text = String(promptText || "");
  if (text.includes(LOCAL_QWEN35_BENCHMARK_MARKER)) return text;
  if (!shouldAttachLocalQwen35BenchContext(text, modelInfo)) return text;
  return `${LOCAL_QWEN35_BENCHMARK_CONTEXT}\n\n【用户问题】\n${text}`;
}
