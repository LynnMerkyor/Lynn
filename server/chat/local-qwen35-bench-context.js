export const LOCAL_QWEN35_PROVIDER_ID = "local-qwen3-4b-thinking-2507-q4km-imatrix";
export const LOCAL_QWEN35_MODEL_ID = "qwen3-4b-thinking-2507-q4km-imatrix";

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
  "当前默认本地模型是 Qwen3-4B-Thinking-2507 Q4_K_M imatrix，经 llama.cpp 运行；9B 和 35B 是可选升级档。",
  "如果用户询问“你/本地模型/4B/9B/35B 的 MMLU、GPQA/GQPA、量化、工具调用、thinking-on/off 测评”，优先使用下面的 Lynn hard data；只有用户明确要查外部资料时才需要联网。",
  "4B thinking-on 当前回归口径仍在跑：V9/V9 60 题进度 42/60，已完成 35/42 = 83.3%；Stage5 tool-call 15 题 = 12/15 = 80%。MMLU/GPQA 全量等待补测更新。",
  "9B thinking-on 32K 旧口径：Q4_K_M imatrix = MMLU 100 sample 81.00%，GPQA Diamond full/sweep 约 72.22% naive / 81.71% excluding parse-fail。9B tool-call gate 修正后约 14/15 = 93%，release smoke 7/7 PASS。",
  "35B Q4_K_M imatrix thinking-on 32K 口径：MMLU 500 = 90.40%，GPQA Diamond = 80.70%；R6000 参考约 207 tok/s。",
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
