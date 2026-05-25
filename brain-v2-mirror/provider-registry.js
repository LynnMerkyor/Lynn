// Brain v2 · Provider Registry
// 原则:只做事实型(capability + 健康/cooldown),不做内容判断
import 'dotenv/config';

const env = (k, d) => process.env[k] || d;

export const PROVIDERS = {
  'mimo': {
    id: 'mimo',
    endpoint: env('MIMO_SEARCH_BASE', 'https://token-plan-cn.xiaomimimo.com/v1'),
    apiKey: env('MIMO_SEARCH_KEY', ''),
    model: env('MIMO_SEARCH_MODEL', 'mimo-v2.5-pro'),
    capability: { vision: false, audio: false, tools: true, thinking: true, native_search: true },
    wire: 'mimo',
    cooldown_ms: 300_000,
  },
  'apex-spark-i-balanced': {
    id: 'apex-spark-i-balanced',
    endpoint: env('APEX_SPARK_BASE', 'http://127.0.0.1:18098/v1'),
    apiKey: 'none',
    // 2026-05-25: 实际 Spark llama-server `-a` alias 是 qwen36-35b-a3b-apex-mtp
    // (lynn-apex-mtp-llamacpp.service)。之前 default 'apex-i-balanced' 跟 server alias
    // mismatch,fallback 触发就 404,所以 MiMo 降级链路一直没真跑过。
    model: env('APEX_SPARK_MODEL', 'qwen36-35b-a3b-apex-mtp'),
    capability: { vision: false, audio: false, tools: true, thinking: true, native_search: false },
    wire: 'openai',
    cooldown_ms: 300_000,
    // 2026-05-25: 默认 thinking-off,跟 MiMo 行为对齐。短 max_tokens 工况下避免 35B 长思考
    // 把 reasoning_content 吃光、content 空、用户拿到空答案。client 通过 reasoning_effort
    // (非 'off' / 'none')显式 opt-in 才走 thinking-on。
    default_thinking: false,
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
    model: env('ZHIPU_CODING_TURBO_MODEL', 'GLM-5-Turbo'),
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

// universalOrder — 单一兜底链路,不按 prompt 内容分支
export const universalOrder = [
  'mimo',                  // 头位:enable_search:true 内置搜索 + thinking
  'apex-spark-i-balanced', // MIMO fallback:Spark llama.cpp APEX-I-Balanced(127.0.0.1:18098 via frps)
  'deepseek-chat',         // 云兜底 V4-flash
  'deepseek-pro',          // 云兜底 V4-pro
  'glm-5-turbo',           // 末位
];

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

// C21: snapshot for /v2/state metrics endpoint
export function getCooldownState() {
  const now = Date.now();
  const out = {};
  for (const [id, st] of cooldownState.entries()) {
    if (st.unhealthyUntil > now) {
      out[id] = { remainingMs: st.unhealthyUntil - now, reason: st.reason || '' };
    }
  }
  return out;
}
