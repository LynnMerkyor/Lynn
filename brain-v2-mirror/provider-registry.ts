// Brain v2 · Provider Registry
// 原则:只做事实型(capability + 健康/cooldown),不做内容判断
import './env-loader.js';
import { positiveEnvNumber } from './env-utils.js';
import { envModel, providerId, type Provider, type ProviderId, type ProviderIdLiteral } from './types.js';
const DUAL_BRAIN_LOCAL_MANAGER_MAX_CONCURRENCY = 1;

const env = (k: string, d: string): string => process.env[k] || d;

type ProviderRegistry = Record<ProviderIdLiteral, Provider>;

// NOTE: MiMo search is still owned by tool-exec/web_search.ts. Text/agent execution
// uses separate providers so Token Plan Pro and ordinary API UltraSpeed never share keys.
const PROVIDER_DEFS = {
  'apex-spark-i-balanced': {
    id: providerId('apex-spark-i-balanced'),
    endpoint: env('APEX_SPARK_BASE', 'http://127.0.0.1:18098/v1'),
    apiKey: 'none',
    // 2026-06-08: Spark fallback now points at the DS-V4-Pro thinking distilled
    // Q4_K_M orchestrator. Keep the provider id for env/backward compatibility.
    model: envModel('APEX_SPARK_MODEL', 'qwen36-35b-a3b-dsv4pro-distill-q4km-imatrix'),
    capability: { vision: false, audio: false, video: false, tools: true, thinking: true, native_search: false },
    wire: 'openai',
    cooldown_ms: 300_000,
    health_path: '/health',
    health_probe_ms: 2_500,
    // 2026-05-25: 默认 thinking-off。短 max_tokens 工况下避免 35B 长思考
    // 把 reasoning_content 吃光、content 空、用户拿到空答案。client 通过 reasoning_effort
    // (非 'off' / 'none')显式 opt-in 才走 thinking-on。
    default_thinking: false,
    thinking_control: 'qwen_chat_template',
  },
  // MiMo ordinary API UltraSpeed. Agent20 (2026-06-25): 17/20, avg 7.8s,
  // strong execution lane. Keep reasoning low and the output budget roomy enough
  // to avoid reasoning-only empty answers on harder coding turns.
  'mimo-ultraspeed': {
    id: providerId('mimo-ultraspeed'),
    endpoint: env('MIMO_ULTRASPEED_BASE', 'https://api.xiaomimimo.com/v1'),
    apiKey: env('MIMO_ULTRASPEED_KEY', ''),
    model: envModel('MIMO_ULTRASPEED_MODEL', 'mimo-v2.5-pro-ultraspeed'),
    capability: { vision: false, audio: false, video: false, tools: true, thinking: true, native_search: false },
    wire: 'openai',
    cooldown_ms: 30_000,
    default_thinking: true,
    default_reasoning_effort: 'low',
    max_tokens: 16_384,
    timeout_ms: positiveEnvNumber('MIMO_ULTRASPEED_TIMEOUT_MS', 30_000),
    temperature: 0.2,
  },
  // MiMo Token Plan Pro. Quality is usable, but Agent20 showed heavy 90s tail; keep it
  // separate and bounded so a single slow queue does not hold the whole Brain turn.
  'mimo-token-plan-pro': {
    id: providerId('mimo-token-plan-pro'),
    endpoint: env('MIMO_TOKEN_PLAN_BASE', 'https://token-plan-cn.xiaomimimo.com/v1'),
    apiKey: env('MIMO_TOKEN_PLAN_KEY', ''),
    model: envModel('MIMO_TOKEN_PLAN_MODEL', 'mimo-v2.5-pro'),
    capability: { vision: false, audio: false, video: false, tools: true, thinking: true, native_search: false },
    wire: 'openai',
    cooldown_ms: 60_000,
    default_thinking: true,
    default_reasoning_effort: 'low',
    max_tokens: 16_384,
    timeout_ms: positiveEnvNumber('MIMO_TOKEN_PLAN_TIMEOUT_MS', 30_000),
    temperature: 0.2,
  },
  // [step-3.7-flash v1] StepFun 云 198B-MoE/11B-A(step_plan 端点)。
  // 2026-05-30 high+48K 评测反超旧文本头位(GPQA/MMLU/TPS),Brain 文本头位切 StepFun;
  // 多模态(vision)也由 StepFun 承接:vision_model=step-1o-turbo-vision,Spark 本地兜底。
  // reasoning-always(low/med/high 三档,无真 off);wire=openai(content + tools)。
  'step-3.7-flash': {
    id: providerId('step-3.7-flash'),
    endpoint: env('STEP37_BASE', 'https://api.stepfun.com/step_plan/v1'),
    apiKey: env('STEP37_KEY', ''),
    model: envModel('STEP37_MODEL', 'step-3.7-flash'),
    // StepFun covers vision too: text → model (step-3.7-flash), images → vision_model
    // (step-1o-turbo-vision) via the openai-compat adapter switch on image content.
    vision_model: env('STEP_VISION_MODEL', '') || env('STEP37_VISION_MODEL', ''),
    capability: { vision: true, audio: false, video: true, tools: true, thinking: true, native_search: false },
    wire: 'openai',
    cooldown_ms: 60_000,
    default_thinking: false,
    default_reasoning_effort: 'low',
    // 48K (was 32K): reasoning + answer + tool-call share this one output budget. At high
    // reasoning, hard tasks overflowed 32K mid-<think> → finish_reason=length → empty answer.
    max_tokens: 49_152,
  },
  // MiMo Token Plan multimodal fallback. Official docs expose image/audio/video understanding
  // through the OpenAI-compatible chat completions API; use it after StepFun for image/video,
  // and as the first native audio-capable provider in the multimodal route.
  'mimo-multimodal': {
    id: providerId('mimo-multimodal'),
    endpoint: env('MIMO_MULTIMODAL_BASE', 'https://token-plan-cn.xiaomimimo.com/v1'),
    apiKey: env('MIMO_MULTIMODAL_KEY', ''),
    model: envModel('MIMO_MULTIMODAL_MODEL', 'mimo-v2.5'),
    capability: { vision: true, audio: true, video: true, tools: false, thinking: true, native_search: false },
    wire: 'openai',
    cooldown_ms: 60_000,
    default_thinking: true,
    max_tokens: 8_192,
    temperature: 0.2,
  },
  'deepseek-chat': {
    id: providerId('deepseek-chat'),
    endpoint: env('DEEPSEEK_BASE', 'https://api.deepseek.com/v1'),
    apiKey: env('DEEPSEEK_KEY', ''),
    model: envModel('DEEPSEEK_MODEL', 'deepseek-v4-flash'),
    capability: { vision: false, audio: false, video: false, tools: true, thinking: true, native_search: false },
    wire: 'openai',
    cooldown_ms: 60_000,
    default_thinking: true,
  },
  'deepseek-pro': {
    id: providerId('deepseek-pro'),
    endpoint: env('DEEPSEEK_BASE', 'https://api.deepseek.com/v1'),
    apiKey: env('DEEPSEEK_KEY', ''),
    model: envModel('DEEPSEEK_PRO_MODEL', 'deepseek-v4-pro'),
    capability: { vision: false, audio: false, video: false, tools: true, thinking: true, native_search: false },
    wire: 'openai',
    cooldown_ms: 60_000,
    default_thinking: true,
  },
  'glm-5-turbo': {
    id: providerId('glm-5-turbo'),
    endpoint: env('ZHIPU_CODING_BASE', 'https://open.bigmodel.cn/api/coding/paas/v4'),
    apiKey: env('ZHIPU_KEY', ''),
    model: envModel('ZHIPU_CODING_TURBO_MODEL', 'GLM-5-Turbo'),
    capability: { vision: false, audio: false, video: false, tools: true, thinking: false, native_search: true },
    wire: 'openai',
    cooldown_ms: 60_000,
    default_thinking: true,
  },
  // [glm-coding v1] Year-paid coding plan endpoint, used as VERIFIER_PROVIDER (NOT in universalOrder)
  'glm-coding': {
    id: providerId('glm-coding'),
    endpoint: env('ZHIPU_CODING_BASE', 'https://open.bigmodel.cn/api/coding/paas/v4'),
    apiKey: env('ZHIPU_KEY', ''),
    model: envModel('ZHIPU_CODING_TURBO_MODEL', 'GLM-5-Turbo'),
    capability: { vision: false, audio: false, video: false, tools: true, thinking: true, native_search: false },
    wire: 'openai',
    cooldown_ms: 60_000,
    default_thinking: true,
  },
} satisfies ProviderRegistry;

export const PROVIDERS: Record<string, Provider> = PROVIDER_DEFS;

// universalOrder — 文本/工具编排链路。2026-06-25 Agent20:
// UltraSpeed 是当前最强执行候选;Step/DS V4 Flash 保留为复核/打回式 fallback。
// Token Plan Pro 因长尾只放后段,并由 provider timeout 截断慢队列。
export const universalOrder = [
  providerId('mimo-ultraspeed'),       // 头位:普通 MiMo API UltraSpeed,Agent 执行优先
  providerId('step-3.7-flash'),        // 高速复核/打回 fallback:StepFun 3.7 Flash low+48K
  providerId('deepseek-chat'),         // DS V4 Flash 复核/事实编排 fallback
  providerId('apex-spark-i-balanced'), // 本地 A3B 单槽 manager/fallback;忙时 router 跳过,保护 GUI 交互
  providerId('mimo-token-plan-pro'),   // Token Plan Pro 质量可用但长尾重,限时后段兜底
  providerId('deepseek-pro'),          // 云兜底 V4-pro
  providerId('glm-5-turbo'),           // 末位
] as const satisfies readonly ProviderId[];

const multimodalOrder = [
  providerId('step-3.7-flash'),        // 多模态仍由 StepFun/vision_model 承接
  providerId('mimo-multimodal'),       // MiMo 原生图片/音频/视频兜底;audio 首个可用 provider
  providerId('apex-spark-i-balanced'),
  providerId('deepseek-chat'),
  providerId('deepseek-pro'),
  providerId('glm-5-turbo'),
] as const satisfies readonly ProviderId[];

export function providerOrderForCapability(capabilityRequired?: { vision?: boolean; audio?: boolean; video?: boolean }): readonly ProviderId[] {
  if (capabilityRequired?.vision || capabilityRequired?.audio || capabilityRequired?.video) {
    // 多模态首位 = StepFun(step-3.7-flash,vision_model=step-1o-turbo-vision,capability.vision/video=true)。
    // MiMo follows as native image/audio/video fallback; audio requests land there when configured.
    return multimodalOrder;
  }
  return universalOrder;
}

// 健康/cooldown 状态(in-memory,不持久化)
type CooldownState = { unhealthyUntil: number; reason: string };
const cooldownState = new Map<ProviderId, CooldownState>(); // providerId → { unhealthyUntil: timestamp }

export function isInCooldown(providerId: ProviderId): boolean {
  const s = cooldownState.get(providerId);
  if (!s) return false;
  return Date.now() < s.unhealthyUntil;
}
export function markUnhealthy(providerId: ProviderId, reason = '', cooldownMs: number | null = null): void {
  const provider = PROVIDERS[providerId];
  if (!provider) return;
  const duration = Number.isFinite(cooldownMs) && cooldownMs !== null && cooldownMs > 0
    ? cooldownMs
    : provider.cooldown_ms;
  cooldownState.set(providerId, { unhealthyUntil: Date.now() + duration, reason });
}
export function clearUnhealthy(providerId: ProviderId): void {
  cooldownState.delete(providerId);
}
export function getProvider(id: ProviderId | string): Provider | null { return PROVIDERS[id as ProviderId] || null; }

export type ProviderCredentialStatus = 'set' | 'missing' | 'not_required';

export interface ProviderStatusSnapshotEntry {
  id: string;
  model: string;
  endpoint: string;
  wire: string;
  capability: Provider['capability'];
  credential: ProviderCredentialStatus;
  configured: boolean;
  local: boolean;
  inRoute: boolean;
  routeRole?: 'head' | 'local_single_slot_manager' | 'escape' | 'tail';
  localConcurrencyLimit?: number;
  busyFallbackProvider?: string;
}

export interface ProviderStatusSnapshot {
  ok: true;
  route: string[];
  providers: ProviderStatusSnapshotEntry[];
}

function credentialStatus(provider: Provider): ProviderCredentialStatus {
  if (provider.apiKey === 'none' || provider.health_path) return 'not_required';
  return provider.apiKey ? 'set' : 'missing';
}

export function getProviderStatusSnapshot(capabilityRequired?: { vision?: boolean; audio?: boolean; video?: boolean }): ProviderStatusSnapshot {
  const route = providerOrderForCapability(capabilityRequired).map(String);
  const routeSet = new Set(route);
  const headProvider = route[0] || '';
  return {
    ok: true,
    route,
    providers: Object.values(PROVIDERS).map((provider) => {
      const credential = credentialStatus(provider);
      return {
        id: String(provider.id),
        model: String(provider.model),
        endpoint: provider.endpoint,
        wire: provider.wire,
        capability: provider.capability,
        credential,
        configured: credential !== 'missing',
        local: provider.apiKey === 'none' || Boolean(provider.health_path),
        inRoute: routeSet.has(String(provider.id)),
        routeRole: String(provider.id) === headProvider
          ? 'head'
          : String(provider.id) === 'apex-spark-i-balanced'
            ? 'local_single_slot_manager'
            : String(provider.id) === 'step-3.7-flash' || String(provider.id) === 'deepseek-chat'
              ? 'escape'
              : 'tail',
        localConcurrencyLimit: String(provider.id) === 'apex-spark-i-balanced'
          ? DUAL_BRAIN_LOCAL_MANAGER_MAX_CONCURRENCY
          : undefined,
        busyFallbackProvider: String(provider.id) === 'apex-spark-i-balanced'
          ? 'mimo-ultraspeed or step-3.7-flash'
          : undefined,
      };
    }),
  };
}

// C21: snapshot for /v2/state metrics endpoint
export function getCooldownState(): Record<string, { remainingMs: number; reason: string }> {
  const now = Date.now();
  const out: Record<string, { remainingMs: number; reason: string }> = {};
  for (const [id, st] of cooldownState.entries()) {
    if (st.unhealthyUntil > now) {
      out[id] = { remainingMs: st.unhealthyUntil - now, reason: st.reason || '' };
    }
  }
  return out;
}
