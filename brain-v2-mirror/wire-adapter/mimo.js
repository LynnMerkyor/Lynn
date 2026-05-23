// Brain v2 · MiMo wire adapter
// enable_search:true 内置 web search(memory feedback_mimo_token_plan.md)
// F10 fix (2026-05-23): reasoning_effort 全档位都翻译到 MiMo thinking schema,不再 silently drop
//   - low/minimal/off/none → { type: 'disabled' }
//   - medium/high/xhigh    → { type: 'enabled' }  (MiMo server default budget)
//   - undefined/其他       → 不动 body.thinking,由 extraBody 或 server default 决定
//   BYOK-equality:caller 显式 thinking via extraBody 总是 win(在 spread 之后我们才 set)
import { parseOpenAISSE } from './_sse-parser.js';

function reasoningEffortToMimoThinking(effort) {
  // 用户拍板 2026-05-23: caller 不显式传 → 默认 'xhigh'(MiMo thinking 全开)
  const v = String(effort || 'xhigh').toLowerCase();
  if (v === 'low' || v === 'minimal' || v === 'off' || v === 'none') return { type: 'disabled' };
  // medium / high / xhigh / max / 任何未知值 → enabled
  return { type: 'enabled' };
}

export async function* call({ provider, messages, tools, signal, log, extraBody, reasoningEffort }) {
  const body = {
    model: provider.model,
    messages,
    enable_search: true,
    max_completion_tokens: 32768,
    temperature: 0.6,
    stream: true,
    // extraBody spread 末尾 = 客户端可 override
    ...(extraBody && typeof extraBody === 'object' ? extraBody : {}),
  };
  // reasoning_effort 翻译:Lynn ThinkingLevelButton 通过 reasoningEffort 参数传入
  // F10: 也认 extraBody.reasoning_effort,不让 caller intent silently drop
  // 优先级:caller 显式 body.thinking > reasoningEffort 参数 > extraBody.reasoning_effort
  const effortSource = reasoningEffort || body.reasoning_effort;
  const translatedThinking = reasoningEffortToMimoThinking(effortSource);
  if (translatedThinking && !body.thinking) body.thinking = translatedThinking;
  // MiMo 不识别 OpenAI 标准 reasoning_effort 字段,删除避免 400(翻译已上抬到 thinking)
  delete body.reasoning_effort;

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
    throw new Error('mimo HTTP ' + resp.status + ' ' + errText.slice(0, 200));
  }
  yield* parseOpenAISSE(resp.body);
}

export const wireMeta = {
  id: 'mimo',
  desc: 'MiMo with native enable_search:true (xiaomimimo.com token-plan)',
};

// for tests
export const __testing__ = { reasoningEffortToMimoThinking };
