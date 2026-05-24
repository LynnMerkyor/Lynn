export const LOCAL_QWEN35_PROVIDER_ID = "local-qwen35-4b-q4km";
export const LOCAL_QWEN35_MODEL_ID = "qwen35-4b-q4km";

export const LOCAL_QWEN_COMPAT_PROVIDER_IDS = new Set([
  "local-qwen35-4b-q4km",
  "local-qwen3-4b-thinking-2507-q4km-imatrix",
  "local-qwen35-9b-q4km-imatrix",
]);

export const LOCAL_QWEN_COMPAT_MODEL_IDS = new Set([
  "qwen35-4b-q4km",
  "qwen3-4b-thinking-2507-q4km-imatrix",
  "qwen35-9b-q4km-imatrix",
  "qwen36-35b-a3b-q4km-imatrix",
]);

const LOCAL_QWEN35_BENCHMARK_MARKER = "【Lynn 本地模型事实备忘】";

export const LOCAL_QWEN35_BENCHMARK_CONTEXT = [
  LOCAL_QWEN35_BENCHMARK_MARKER,
  "当前默认本地模型是 Qwen3.5-4B Q4_K_M (unsloth)，经 llama.cpp 运行；2.55GB,thinking-on 32K,8~16G 显存推荐。9B MTP 是 24GB+ 升级档,35B APEX-MTP 是 32GB+ 高端档。所有 bench 都是 Q4_K_M 量化态测试,thinking-on 32K 口径。",
  "Qwen3.5-4B Q4_K_M (unsloth, 默认档) thinking-on 32K: MMLU 500 = 81.20%, V8 工具调用修正后 30/35 (85.71%), V9 60-prompt mixed = 46/60 = 76.67% (finance/medical 100%, math/physics/bio/chem 88-89%, code_algo 22% / sql 0% 为弱项)。Spark GB10 baseline ~68 tok/s, 并发 ~52 tok/s。",
  "Qwen3.5-9B Q4_K_M imatrix MTP (升级档,24GB+) thinking-on 32K: MMLU 100 sample = 81.00%, GPQA Diamond full = 72.22% naive / 81.71% excluding parse-fail, tool-call gate 修正后约 14/15 = 93%。GB10 Spark TPS: think-off 1024 = 46.16 tok/s, think-on 4096 = 77.46 tok/s, think-on 32K sustained = 78.32 tok/s。",
  "Qwen3.6-35B-A3B APEX-MTP I-Balanced Q4_K_M (高端档,32GB+) thinking-on 32K: MMLU 500 = 90.40%, GPQA Diamond = 80.70%。GB10 Spark TPS: think-on 4K = 84.69 tok/s, think-on 16K = 75.53 tok/s。35B 短答 think-off 不建议默认开 MTP, 长思考建议 MTP。",
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
  return `${LOCAL_QWEN35_BENCHMARK_CONTEXT}\n\n${text}`;
}
