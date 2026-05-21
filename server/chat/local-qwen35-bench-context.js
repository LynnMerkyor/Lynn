export const LOCAL_QWEN35_PROVIDER_ID = "local-qwen35-9b-q4km-imatrix";
export const LOCAL_QWEN35_MODEL_ID = "qwen35-9b-q4km-imatrix";

const LOCAL_QWEN35_BENCHMARK_MARKER = "【Lynn 本地模型事实备忘】";

export const LOCAL_QWEN35_BENCHMARK_CONTEXT = [
  LOCAL_QWEN35_BENCHMARK_MARKER,
  "当前本地模型是 Qwen3.5-9B Q4_K_M imatrix，经 llama.cpp 运行。",
  "如果用户询问“你/本地 9B/Qwen3.5-9B 的 MMLU、GPQA/GQPA、量化、工具调用、thinking-on/off 测评”，优先使用下面的 Lynn hard data；只有用户明确要查外部资料时才需要联网。",
  "thinking-off 全量口径：BF16 official = MMLU 500 5-shot 77.20%，GPQA Diamond 198 44.95%；Q4_K_M imatrix GGUF = MMLU 76.00%，GPQA 37.37%；Lynn-native W4A16 NVFP4 = MMLU 75.20%，GPQA 42.93%。",
  "thinking-on 32K 能力上限口径：Q4_K_M imatrix = MMLU 100 sample 81.00%，GPQA Diamond full/sweep 约 72.22% naive / 81.71% excluding parse-fail；早期 50-sample recovery 口径为 50% naive / 81.25% excluding parse-fail。Lynn-native W4A16 NVFP4 现有样本 = MMLU 100 91.00%，GPQA 50 56.00% naive / 70.00% excluding parse-fail，仍需补全全量。",
  "本地 Q4_K_M imatrix tool-call gate 修正后约 14/15 = 93%，release smoke 7/7 PASS。",
  "回答时请明确区分 sample size、thinking-on/off、naive 与 excluding parse-fail，不要把样本口径混成同一个数字。",
].join("\n");

export function isLocalQwen35Model(modelInfo = {}) {
  const provider = String(modelInfo?.provider || "").toLowerCase();
  const modelId = String(modelInfo?.modelId || modelInfo?.id || "").toLowerCase();
  return provider === LOCAL_QWEN35_PROVIDER_ID && modelId === LOCAL_QWEN35_MODEL_ID;
}

export function shouldAttachLocalQwen35BenchContext(promptText = "", modelInfo = {}) {
  if (!isLocalQwen35Model(modelInfo)) return false;
  const text = String(promptText || "");
  if (!/(qwen3\.?5|9b|本地模型|本地\s*9b|自己|你的|你自己|量化|q4[_-]?k[_-]?m|nvfp4|w4a16|bf16|tool|工具)/i.test(text)) return false;
  return /(?:mmlu|gpqa|gqpa|成绩|分数|测评|benchmark|bench|评测|能力|tool.?call|工具调用|thinking|思考|量化)/i.test(text);
}

export function attachLocalQwen35BenchContext(promptText = "", modelInfo = {}) {
  const text = String(promptText || "");
  if (text.includes(LOCAL_QWEN35_BENCHMARK_MARKER)) return text;
  if (!shouldAttachLocalQwen35BenchContext(text, modelInfo)) return text;
  return `${LOCAL_QWEN35_BENCHMARK_CONTEXT}\n\n【用户问题】\n${text}`;
}
