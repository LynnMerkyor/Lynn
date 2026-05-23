// Brain v2 · Provider Registry
// 原则:只做事实型(capability + 健康/cooldown),不做内容判断
import 'dotenv/config';

const env = (k, d) => process.env[k] || d;
const envList = (k) => String(process.env[k] || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const PROVIDERS = {
  'local-qwen3-4b-thinking-2507-q4km-imatrix': {
    id: 'local-qwen3-4b-thinking-2507-q4km-imatrix',
    endpoint: env('LYNN_LOCAL_QWEN35_BASE', 'http://127.0.0.1:18099/v1'),
    apiKey: env('LYNN_LOCAL_QWEN35_API_KEY', 'local'),
    model: env('LYNN_LOCAL_QWEN35_MODEL', 'qwen3-4b-thinking-2507-q4km-imatrix'),
    // #7: tools=false because Q4_K_M lacks native tool parser config in llama.cpp default --jinja mode.
    // Router treats tools-attached requests as needing native tool emit; setting tools:false here
    // tells the router to skip local for tool-heavy prompts (downgrade quality avoidance).
    // (thinking still true — local model handles reasoning; only tool-call emit is the gap.)
    capability: { vision: false, audio: false, tools: false, thinking: true, native_search: false },
    wire: 'openai',
    cooldown_ms: 15_000,
    max_tokens: Number(env('LYNN_LOCAL_QWEN35_MAX_TOKENS', '32000')),
    temperature: Number(env('LYNN_LOCAL_QWEN35_TEMPERATURE', '0.4')),
  },
  'mimo': {
    id: 'mimo',
    endpoint: env('MIMO_SEARCH_BASE', 'https://token-plan-cn.xiaomimimo.com/v1'),
    apiKey: env('MIMO_SEARCH_KEY', ''),
    model: env('MIMO_SEARCH_MODEL', 'mimo-v2.5-pro'),
    capability: { vision: false, audio: false, tools: true, thinking: true, native_search: true },
    wire: 'mimo',
    cooldown_ms: 300_000,
  },
  'qwen3.6-35b-a3b': {
    id: 'qwen3.6-35b-a3b',
    endpoint: env('QWEN_LOCAL_BASE_FALLBACK', 'http://127.0.0.1:18002/v1'),
    apiKey: 'none',
    model: env('QWEN_LOCAL_MODEL_FALLBACK', 'Qwen3.6-35B-A3B-FP8'),
    capability: { vision: false, audio: false, tools: true, thinking: true, native_search: false },
    wire: 'sglang',
    cooldown_ms: Number(env('QWEN_LOCAL_COOLDOWN_MS', '60000')),
  },
  'deepseek-chat': {
    id: 'deepseek-chat',
    endpoint: env('DEEPSEEK_BASE', 'https://api.deepseek.com/v1'),
    apiKey: env('DEEPSEEK_KEY', ''),
    model: env('DEEPSEEK_MODEL', 'deepseek-v4-flash'),
    capability: { vision: false, audio: false, tools: true, thinking: true, native_search: false },
    wire: 'openai',
    cooldown_ms: 60_000,
  },
  'deepseek-pro': {
    id: 'deepseek-pro',
    endpoint: env('DEEPSEEK_BASE', 'https://api.deepseek.com/v1'),
    apiKey: env('DEEPSEEK_KEY', ''),
    model: env('DEEPSEEK_PRO_MODEL', 'deepseek-v4-pro'),
    capability: { vision: false, audio: false, tools: true, thinking: true, native_search: false },
    wire: 'openai',
    cooldown_ms: 60_000,
  },
  'glm-5-turbo': {
    id: 'glm-5-turbo',
    endpoint: env('ZHIPU_CODING_BASE', 'https://open.bigmodel.cn/api/coding/paas/v4'),
    apiKey: env('ZHIPU_KEY', ''),
    model: env('ZHIPU_MODEL', 'glm-5-turbo'),
    capability: { vision: false, audio: false, tools: true, thinking: false, native_search: true },
    wire: 'openai',
    cooldown_ms: 60_000,
  },
  // [glm-coding v1] Year-paid coding plan endpoint, used as VERIFIER_PROVIDER (NOT in universalOrder)
  'glm-coding': {
    id: 'glm-coding',
    endpoint: env('ZHIPU_CODING_BASE', 'https://open.bigmodel.cn/api/coding/paas/v4'),
    apiKey: env('ZHIPU_KEY', ''),
    model: env('ZHIPU_CODING_TURBO_MODEL', 'GLM-5-Turbo'),
    capability: { vision: false, audio: false, tools: true, thinking: true, native_search: false },
    wire: 'openai',
    cooldown_ms: 60_000,
  },
};

// universalOrder — 单一兜底链路,不按 prompt 内容分支。
// DeepSeek Pro shares the same endpoint/key as DeepSeek Chat, so it is no
// longer in the default chain; operators can opt back in with
// BRAIN_V2_UNIVERSAL_ORDER if they intentionally want that duplicate lane.
const DEFAULT_UNIVERSAL_ORDER = [
  'local-qwen3-4b-thinking-2507-q4km-imatrix', // Mac/local-first: falls back quickly when endpoint is not running
  'mimo',                  // 头位:enable_search:true 内置搜索 + thinking
  'qwen3.6-35b-a3b',       // DGX SGLang FP8 备链
  'deepseek-chat',         // 云兜底 V4-flash
];
const disabledProviders = new Set(envList('BRAIN_V2_DISABLED_PROVIDERS'));
export const universalOrder = (
  envList('BRAIN_V2_UNIVERSAL_ORDER').length > 0
    ? envList('BRAIN_V2_UNIVERSAL_ORDER')
    : DEFAULT_UNIVERSAL_ORDER
).filter((id) => PROVIDERS[id] && !disabledProviders.has(id));

// 健康/cooldown 状态(in-memory,不持久化)
const cooldownState = new Map(); // providerId → { unhealthyUntil: timestamp }

export function isInCooldown(providerId) {
  const s = cooldownState.get(providerId);
  if (!s) return false;
  return Date.now() < s.unhealthyUntil;
}
export function markUnhealthy(providerId, reason = '', cooldownMs = null) {
  const provider = PROVIDERS[providerId];
  if (!provider) return;
  const duration = Number.isFinite(cooldownMs) && cooldownMs > 0
    ? cooldownMs
    : provider.cooldown_ms;
  cooldownState.set(providerId, { unhealthyUntil: Date.now() + duration, reason });
}
export function clearUnhealthy(providerId) {
  cooldownState.delete(providerId);
}
export function getProvider(id) { return PROVIDERS[id] || null; }
