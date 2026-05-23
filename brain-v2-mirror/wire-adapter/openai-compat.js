// Brain v2 · Generic OpenAI-compat wire adapter
// 用于 DeepSeek (V4-flash / V4-pro) / GLM / Kimi / 大部分云模型
// F11 fix (2026-05-23): reasoning_effort 透传 (server.js 把它抽到独立 arg,这里 inject 回 body)
//   OpenAI 标准字段,DeepSeek/GLM/Kimi 都原生支持
import { parseOpenAISSE } from './_sse-parser.js';

export async function* call({ provider, messages, tools, signal, log, extraBody, reasoningEffort }) {
  const body = {
    model: provider.model,
    messages,
    max_tokens: provider.max_tokens || 4096,
    temperature: provider.temperature ?? 0.6,
    stream: true,
    ...(extraBody && typeof extraBody === 'object' ? extraBody : {}),
  };
  // F11: reasoning_effort BYOK 透传 — server.js 抽到 arg,extraBody 没的话从 arg 回灌
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
      Authorization: 'Bearer ' + provider.apiKey,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(provider.id + ' HTTP ' + resp.status + ' ' + errText.slice(0, 200));
  }
  yield* parseOpenAISSE(resp.body);
}

export const wireMeta = {
  id: 'openai-compat',
  desc: 'Generic OpenAI-compatible (DeepSeek / GLM / Kimi / etc.)',
};
