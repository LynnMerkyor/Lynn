// Brain v2 · SGLang wire adapter (BYOK-equality pipe)
// Qwen3.6-A3B-FP8 + qwen3_coder parser native tool_calls + reasoning_content
// F9 fix (2026-05-23): 不再 force enable_thinking=false。caller 通过 extra_body.chat_template_kwargs
//   显式控制(跟 BYOK 直连 SGLang 同行为)。caller 不给 → 让 SGLang 模板 default 决定。
import { parseOpenAISSE } from './_sse-parser.js';

export async function* call({ provider, messages, tools, signal, log, extraBody, reasoningEffort }) {
  const {
    chat_template_kwargs: callerTemplateKwargs,
    ...restExtraBody
  } = extraBody && typeof extraBody === 'object' ? extraBody : {};
  const body = {
    model: provider.model,
    messages,
    max_tokens: 32000,
    temperature: 0.4,
    stream: true,
    ...restExtraBody,
  };
  // F9: 只在 caller 显式传 chat_template_kwargs 时透传,否则 omit (让 server template default 决定)
  if (callerTemplateKwargs && typeof callerTemplateKwargs === 'object') {
    body.chat_template_kwargs = { ...callerTemplateKwargs };
  }
  // F11: reasoning_effort BYOK 透传 — SGLang 不一定原生认,但保留 caller intent
  // (server.js 把它抽到独立 arg,这里如 extraBody 没,从 arg 回灌)
  if (reasoningEffort && !body.reasoning_effort) {
    body.reasoning_effort = reasoningEffort;
  }
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  const resp = await fetch(provider.endpoint + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + (provider.apiKey || 'none'),
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error('sglang HTTP ' + resp.status + ' ' + errText.slice(0, 200));
  }
  yield* parseOpenAISSE(resp.body);
}

export const wireMeta = {
  id: 'sglang',
  desc: 'SGLang Qwen3.6-A3B FP8 with reasoning_content + native tool_calls',
};
