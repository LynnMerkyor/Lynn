// Brain v2 · Generic OpenAI-compat wire adapter
// 用于 DeepSeek (V4-flash / V4-pro) / GLM / Kimi / 大部分云模型
// F11 fix (2026-05-23): reasoning_effort 透传 (server.js 把它抽到独立 arg,这里 inject 回 body)
//   OpenAI 标准字段,DeepSeek/GLM/Kimi 都原生支持
// F12 fix (2026-05-27): reasoningEffort='auto'/null 时智能 detect thinking on/off
//   + max_tokens 动态调整(短答 512 / 长think 4096)。避免 default_thinking=false provider
//   被 ThinkingLevelButton 'auto' 一刀切打开 thinking。
import { parseOpenAISSE } from './_sse-parser.js';
import { sanitizeToolsForWire, sanitizeMessagesForWire, restoreToolNameInChunk } from './_tool-name-codec.js';
import type { ChatMessage, ModelId, StreamChunk, ToolDefinition, WireAdapterOptions } from '../types.js';

function messageText(message?: ChatMessage): string {
  if (!message) return '';
  if (typeof message.content === 'string') {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    return (message.content as Array<{ type?: string; text?: string }>)
      .map((c) => (typeof c?.text === 'string' ? c.text : ''))
      .join('');
  }
  return '';
}

function lastPromptText(messages?: ChatMessage[]): string {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') {
      return messageText(messages[i]).trim();
    }
  }
  return messageText(messages[messages.length - 1]).trim();
}

// F12: 智能判断是否需要 thinking
// - 短问候/单一指令/简单查询 → false (节省 token + 降延迟)
// - 包含推理关键词 / 长问题(>80 字)→ true (深度思考)
function shouldAutoThink(messages?: ChatMessage[]): boolean {
  const text = lastPromptText(messages);
  if (!text) return false;
  // 简单问候/确认 → 不开
  if (/^(你好|您好|hi|hello|hey|嗨|早|早上好|晚安|谢谢|好的|是的|嗯|ok|okay)[!,。.?? ]*$/i.test(text)) {
    return false;
  }
  // 包含明确思考关键词 → 开
  if (/(为什么|如何|分析|推理|证明|计算|步骤|规划|设计|方案|对比|评估|论述|解释|思考|拆解|策略|架构|逻辑)/.test(text)) {
    return true;
  }
  // 数学/代码/算法/实现 → 开
  if (/(算法|代码|函数|实现|class |function |def |implement|算一下|求解|公式|方程|架构|系统|设计一个|写一个)/i.test(text)) {
    return true;
  }
  // 短问题(<30 字)→ 不开
  if (text.length < 30) return false;
  // 中长问题(>80 字)→ 开
  return text.length > 80;
}

function shouldPreserveRealtimeAnswerBudget(messages?: ChatMessage[], tools?: ToolDefinition[]): boolean {
  const text = lastPromptText(messages);
  if (!text) return false;
  if (Array.isArray(tools) && tools.length === 0) return false;
  return /(今天|今日|今晚|今早|明天|昨日|昨天|最新|现在|目前|实时|新闻|天气|比分|赛程|赛果|预测|股价|股票|汇率|金价|油价|价格|票价|航班|世界杯|比赛|current|latest|today|tonight|tomorrow|yesterday|weather|score|fixture|schedule|result|prediction|price|stock|rate|news|world cup|match|game)/iu.test(text);
}

type OpenAICompatRequestBody = Record<string, unknown> & {
  model: ModelId;
  messages?: ChatMessage[];
  max_tokens: number;
  temperature: number;
  stream: boolean;
  stream_options?: Record<string, unknown>;
  reasoning_effort?: string | null;
  chat_template_kwargs?: Record<string, unknown>;
  tools?: ToolDefinition[];
  tool_choice?: 'auto';
};

function shouldForwardReasoningEffort(provider: WireAdapterOptions['provider'], reasoningEffort?: string | null): boolean {
  if (!reasoningEffort) return false;
  if (provider.thinking_control === 'qwen_chat_template') return true;
  return reasoningEffort !== 'auto'
    && reasoningEffort !== 'off'
    && reasoningEffort !== 'none'
    && reasoningEffort !== 'disabled';
}

// ── Vision routing helpers (2026-06-10 Bug A fix) ──
// step-1o-turbo-vision caps at 32K ctx while step-3.7-flash text is 256K. Routing a turn to
// the vision model just because SOME old image sits in history pins long convos to 32K →
// context overflow → no answer. Only a RECENT image should trigger vision routing.
const VISION_RECENT_LOOKBACK = 6;
function contentPartHasImage(c: { type?: string }): boolean {
  return c?.type === 'image_url' || c?.type === 'input_image';
}
function messageHasVisionInput(m: ChatMessage | undefined): boolean {
  return !!m && Array.isArray(m.content)
    && (m.content as Array<{ type?: string }>).some(contentPartHasImage);
}
function hasRecentImage(messages?: ChatMessage[]): boolean {
  if (!Array.isArray(messages)) return false;
  return messages.slice(-VISION_RECENT_LOOKBACK).some(messageHasVisionInput);
}
// Replace image blocks with a text placeholder so the large-context text model can carry a
// long history that merely contains stale images, without being fed image content it rejects.
function stripImageContent(messages?: ChatMessage[]): ChatMessage[] | undefined {
  if (!Array.isArray(messages)) return messages;
  let changed = false;
  const out = messages.map((m) => {
    if (!messageHasVisionInput(m)) return m;
    changed = true;
    const content = (m.content as Array<{ type?: string }>).map((c) =>
      contentPartHasImage(c) ? { type: 'text', text: '[earlier image omitted]' } : c);
    return { ...m, content } as ChatMessage;
  });
  return changed ? out : messages;
}

export async function* call({ provider, messages, tools, signal, extraBody, reasoningEffort }: WireAdapterOptions): AsyncGenerator<StreamChunk> {
  const effectiveReasoningEffort =
    provider.default_reasoning_effort && (!reasoningEffort || reasoningEffort === 'auto')
      ? provider.default_reasoning_effort
      : reasoningEffort;
  // Vision routing (Bug A fix): route to the small-context vision model ONLY when a RECENT
  // message carries an image. When not, use the large-context text model and strip stale
  // image blocks so it isn't fed image content it may reject.
  const hasRecentVisionInput = hasRecentImage(messages);
  const wantsVisionModel = !!provider.vision_model && hasRecentVisionInput;
  const nativeVisionOnBaseModel = Boolean(provider.capability?.vision && !provider.vision_model && hasRecentVisionInput);
  const model = (wantsVisionModel ? provider.vision_model : provider.model) as ModelId;
  const routedMessages = (wantsVisionModel || nativeVisionOnBaseModel) ? messages : stripImageContent(messages);
  // Some providers (DeepSeek) reject tool/function names outside ^[a-zA-Z0-9_-]+$;
  // rewrite historical tool_call names in the messages to match the tools array below.
  const wireMessages = sanitizeMessagesForWire(routedMessages);
  const body: OpenAICompatRequestBody = {
    model,
    messages: wireMessages,
    max_tokens: provider.max_tokens || 4096,
    temperature: provider.temperature ?? 0.6,
    stream: true,
    stream_options: { include_usage: true },
    ...(extraBody && typeof extraBody === 'object' ? extraBody : {}),
  };
  // F11: reasoning_effort BYOK 透传 — server.js 抽到 arg,extraBody 没的话从 arg 回灌
  if (shouldForwardReasoningEffort(provider, effectiveReasoningEffort) && !body.reasoning_effort) {
    body.reasoning_effort = effectiveReasoningEffort;
  }
  // 2026-05-25: provider.default_thinking === false 时(例如 apex-spark Brain v2 fallback),
  // 默认关 thinking。避免短 max_tokens 工况下 35B 长 reasoning 吃光
  // 预算返回空 content。client 通过 reasoning_effort('low'/'medium'/'high'/'on')显式
  // opt-in,或 extraBody.chat_template_kwargs.enable_thinking 直接覆盖。
  if (provider.default_thinking === false
      && provider.thinking_control === 'qwen_chat_template'
      && body?.chat_template_kwargs?.enable_thinking === undefined) {
    // F12: 'auto' or null → 智能 detect (短答 off / 长 think on)
    // 显式 'high'/'xhigh'/'on'/'medium'/'low' → 强制 on
    // 'off'/'none'/'disabled' → 强制 off
    let wantsThinking: boolean;
    if (!effectiveReasoningEffort || effectiveReasoningEffort === 'auto') {
      wantsThinking = shouldAutoThink(messages);
    } else if (effectiveReasoningEffort === 'off' || effectiveReasoningEffort === 'none' || effectiveReasoningEffort === 'disabled') {
      wantsThinking = false;
    } else {
      wantsThinking = true;
    }
    const chatTemplateKwargs = body.chat_template_kwargs && typeof body.chat_template_kwargs === 'object'
      ? body.chat_template_kwargs
      : {};
    body.chat_template_kwargs = {
      ...chatTemplateKwargs,
      enable_thinking: wantsThinking,
    };
    // F12: 智能 max_tokens — 短答 512 节省;长 think/实时工具问答维持 provider.max_tokens || 4096
    // 用户/extraBody 显式传 max_tokens 时不覆盖(已在初始 body 里设过了,这里只在 default 情况下调小)
    const userOverridesMaxTokens = (extraBody && typeof extraBody === 'object' && 'max_tokens' in (extraBody as object));
    if (!wantsThinking && !userOverridesMaxTokens && !shouldPreserveRealtimeAnswerBudget(messages, tools ?? undefined)) {
      body.max_tokens = 512;
    }
  }
  // Sanitize tool names on the way out (DeepSeek strict pattern); restore on the way back
  // so the brain pipeline only ever sees the original names. Conforming names → no-op.
  let toolNameRestore = null;
  if (Array.isArray(tools) && tools.length > 0 && provider.capability?.tools !== false) {
    const sanitized = sanitizeToolsForWire(tools);
    body.tools = sanitized.tools;
    body.tool_choice = 'auto';
    toolNameRestore = sanitized.restore;
  }
  const postChat = (b: OpenAICompatRequestBody) => fetch(provider.endpoint + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + provider.apiKey,
    },
    body: JSON.stringify(b),
    signal,
  });
  let resp = await postChat(body);
  // Option-4 fallback (Bug A): if the vision model overflows its 32K context, retry once on
  // the text model with images stripped — a long image-bearing convo still gets answered.
  if (!resp.ok && wantsVisionModel && resp.status === 400) {
    const errText = await resp.text().catch(() => '');
    if (/maximum context length|context length|too long/i.test(errText)) {
      body.model = provider.model as ModelId;
      body.messages = sanitizeMessagesForWire(stripImageContent(messages));
      resp = await postChat(body);
    } else {
      throw new Error(provider.id + ' HTTP ' + resp.status + ' ' + errText.slice(0, 200));
    }
  }
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(provider.id + ' HTTP ' + resp.status + ' ' + errText.slice(0, 200));
  }
  if (toolNameRestore) {
    for await (const chunk of parseOpenAISSE(resp.body)) {
      yield restoreToolNameInChunk(chunk, toolNameRestore);
    }
  } else {
    yield* parseOpenAISSE(resp.body);
  }
}

export const wireMeta = {
  id: 'openai-compat',
  desc: 'Generic OpenAI-compatible (DeepSeek / GLM / Kimi / etc.)',
};
