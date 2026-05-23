// Brain v2 · Router — BYOK-equality thin pipe
// 原则: 只做事实层 (provider universalOrder + cooldown + capability gate + wire adapter)
//       + 服务端工具回灌循环。不注入 system prompt,不限工具调用次数(env 可配),不检测/拒绝伪工具,
//       不强制 synthesis,不解析模型内容做策略判断。BYOK 直连什么样,brain 就什么样。
//
// 2026-05-23 重构: 砍掉 ~500 行 synthesis + pseudo-tool detection + buffered content 干涉。

import { universalOrder, getProvider, isInCooldown, markUnhealthy, clearUnhealthy } from './provider-registry.js';
import { getAdapter } from './wire-adapter/index.js';
import { isServerTool, executeServerTool, mergeWithServerTools } from './tool-exec/index.js';

function isProviderConfigured(provider) {
  if (!provider) return false;
  if (provider.apiKey && provider.apiKey !== '') return true;
  if (provider.apiKey === 'none') return true;
  if (provider.authType === 'none') return true;
  return false;
}

// Tool loop guard. Default raised to 50 — long research / agentic chains need 20-30 turns.
// Set BRAIN_V2_MAX_ITERATIONS=0 for unlimited (only abort on real errors).
const MAX_ITERATIONS = Number(process.env.BRAIN_V2_MAX_ITERATIONS || 50);
// P1#4: empty_response 不立即 cooldown。短期 cooldown,需累计 ≥ 2 次 transport-empty(零 SSE chunks)
// 注: 此判断只看 transport 层 anyEmit,不窥探 content。一个 finish_reason=stop+空 content 不会触发。
const EMPTY_RESPONSE_COOLDOWN_MS = Number(process.env.BRAIN_V2_EMPTY_COOLDOWN_MS || 30_000);
const EMPTY_THRESHOLD = Number(process.env.BRAIN_V2_EMPTY_THRESHOLD || 2);
const _emptyCounters = new Map();
// Local provider fast probe (cold-start race avoidance). Opt-out via env.
const LOCAL_HEALTH_PROBE_ENABLED = process.env.BRAIN_V2_LOCAL_HEALTH_PROBE !== '0';

function _bumpEmpty(providerId) {
  const n = (_emptyCounters.get(providerId) || 0) + 1;
  _emptyCounters.set(providerId, n);
  return n;
}
function _resetEmpty(providerId) {
  _emptyCounters.delete(providerId);
}

async function runRound({
  messages,
  tools,
  capabilityRequired,
  signal,
  onChunk,
  log,
  extraBody,
  reasoningEffort,
}) {
  const errors = [];
  for (const providerId of universalOrder) {
    const provider = getProvider(providerId);
    if (!provider) continue;
    if (!isProviderConfigured(provider)) {
      log && log('info', `provider ${providerId} has no credential, skip`);
      continue;
    }
    if (capabilityRequired?.vision && !provider.capability.vision) continue;
    if (capabilityRequired?.audio && !provider.capability.audio) continue;
    // Capability check only: providers that declare no tool support are skipped for tool-attached requests.
    if (Array.isArray(tools) && tools.length > 0 && provider.capability && provider.capability.tools === false) {
      log && log('info', `provider ${providerId} skipped: tool-call request but capability.tools=false`);
      continue;
    }
    if (isInCooldown(providerId)) {
      log && log('info', `provider ${providerId} in cooldown, skip`);
      continue;
    }
    // 本地 provider 快速探针 (避免 cold-start race + 1s ECONNREFUSED)。BRAIN_V2_LOCAL_HEALTH_PROBE=0 关
    if (LOCAL_HEALTH_PROBE_ENABLED && provider.endpoint && /^https?:\/\/(127\.0\.0\.1|localhost)/i.test(provider.endpoint)) {
      try {
        const probeCtrl = new AbortController();
        const probeTimer = setTimeout(() => probeCtrl.abort(), 800);
        const probeRes = await fetch(provider.endpoint + '/models', { method: 'GET', signal: probeCtrl.signal })
          .catch(() => null);
        clearTimeout(probeTimer);
        if (!probeRes || !probeRes.ok) {
          log && log('info', `provider ${providerId} fast-probe failed, skip+cooldown`);
          markUnhealthy(providerId, 'health-probe-failed', 5000);
          continue;
        }
      } catch {
        log && log('info', `provider ${providerId} fast-probe threw, skip+cooldown`);
        markUnhealthy(providerId, 'health-probe-threw', 5000);
        continue;
      }
    }

    const adapter = getAdapter(provider.wire);
    let anyEmit = false;
    let finishReason = null;
    let contentAccum = '';
    const toolCallsAcc = [];
    try {
      log && log('info', `→ provider ${providerId}`);
      for await (const chunk of adapter({ provider, messages, tools, signal, log, extraBody, reasoningEffort })) {
        anyEmit = true;
        if (chunk.type === 'content') {
          contentAccum += chunk.delta;
          await onChunk(chunk, { providerId });
          continue;
        }
        if (chunk.type === 'tool_call_delta') {
          for (const d of (chunk.delta || [])) {
            const idx = d.index ?? 0;
            if (!toolCallsAcc[idx]) toolCallsAcc[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
            if (d.id) toolCallsAcc[idx].id = d.id;
            if (d.function?.name) toolCallsAcc[idx].function.name += d.function.name;
            if (d.function?.arguments) toolCallsAcc[idx].function.arguments += d.function.arguments;
          }
          await onChunk(chunk, { providerId });
          continue;
        }
        if (chunk.type === 'finish') {
          finishReason = chunk.reason;
          await onChunk(chunk, { providerId });
          continue;
        }
        await onChunk(chunk, { providerId });
      }
      // anyEmit=false 表示 transport 层零 SSE chunks (真正 wire 失败)。
      // 注意: 这不是检测 "content 为空" — 一个 finish_reason=stop+空 content 仍算正常,因为 chunks≥1。
      if (!anyEmit) {
        const n = _bumpEmpty(providerId);
        log && log('warn', `provider ${providerId} transport-empty (${n}/${EMPTY_THRESHOLD})`);
        if (n >= EMPTY_THRESHOLD) {
          log && log('warn', `provider ${providerId} reached empty threshold, ${EMPTY_RESPONSE_COOLDOWN_MS}ms cooldown`);
          markUnhealthy(providerId, 'empty_response_threshold', EMPTY_RESPONSE_COOLDOWN_MS);
        }
        continue;
      }
      _resetEmpty(providerId);
      return {
        ok: true,
        providerId,
        finishReason,
        toolCalls: toolCallsAcc.filter(Boolean),
        contentAccum,
      };
    } catch (e) {
      errors.push({ providerId, error: e.message });
      const logMsg = e.suppressBody
        ? `provider ${providerId} failed: HTTP-auth (suppressed), fallback`
        : `provider ${providerId} failed: ${e.message}, fallback`;
      log && log('warn', logMsg);
      markUnhealthy(providerId, e.message, e.cooldownMs); // variable cooldown for auth fail
      continue;
    }
  }
  const err = new Error('all providers failed');
  err.errors = errors;
  throw err;
}

export async function run({ messages, tools, capabilityRequired, signal, onChunk, log, extraBody, reasoningEffort }) {
  // Capability pre-flight — vision/audio capability gate, friendly error if no provider supports
  if (capabilityRequired && (capabilityRequired.vision || capabilityRequired.audio)) {
    const anySupports = universalOrder.some((id) => {
      const p = getProvider(id);
      if (!p) return false;
      if (capabilityRequired.vision && !p.capability.vision) return false;
      if (capabilityRequired.audio && !p.capability.audio) return false;
      return true;
    });
    if (!anySupports) {
      const missing = [capabilityRequired.vision && 'vision', capabilityRequired.audio && 'audio'].filter(Boolean).join('+');
      const err = new Error(`CAPABILITY_NOT_SUPPORTED: no provider supports ${missing} in current build`);
      err.code = 'CAPABILITY_NOT_SUPPORTED';
      throw err;
    }
  }

  const mergedTools = mergeWithServerTools(tools);
  let workingMessages = [...(messages || [])];
  const originalMessages = [...(messages || [])];
  let lastProviderId = null;
  let iter = 0;
  const maxIter = MAX_ITERATIONS > 0 ? MAX_ITERATIONS : Infinity;

  while (iter < maxIter) {
    iter++;
    const result = await runRound({
      messages: workingMessages, tools: mergedTools, capabilityRequired,
      signal, onChunk, log, extraBody, reasoningEffort,
    });
    lastProviderId = result.providerId;

    // Model 自然结束 (stop / length / content_filter / function_call 等非 tool_calls) → 透传完成
    if (result.finishReason !== 'tool_calls' || result.toolCalls.length === 0) {
      return { ok: true, providerId: lastProviderId, iterations: iter };
    }

    const serverCalls = result.toolCalls.filter((tc) => isServerTool(tc.function?.name));
    const clientCalls = result.toolCalls.filter((tc) => !isServerTool(tc.function?.name));

    // 客户端工具 (client 自己执行) → 透传 tool_calls 到客户端,loop 退出
    if (clientCalls.length > 0) {
      log && log('info', `iter ${iter}: ${clientCalls.length} client-side tool_calls forwarded, stop loop`);
      return {
        ok: true, providerId: lastProviderId, iterations: iter,
        forwardedToClient: true, clientToolCalls: clientCalls.length,
        toolCalls: result.toolCalls,
        bufferedContentChunks: [],
        bufferedFinishChunk: { type: 'finish', reason: 'tool_calls' },
      };
    }

    // 服务端工具 → brain 代执行,结果回灌 messages,下一轮再问 model
    log && log('info', `iter ${iter}: ${serverCalls.length} server-side tool_calls, executing...`);
    workingMessages.push({
      role: 'assistant',
      content: result.contentAccum || null,
      tool_calls: result.toolCalls,
    });
    for (const tc of serverCalls) {
      const t0 = Date.now();
      // 工具进度通过自定义 chunk type 表达,不污染 content stream (F5 fix)
      // Lynn UI 消费 type=tool_progress;非 Lynn 客户端 ignored。
      await onChunk(
        { type: 'tool_progress', event: 'start', name: tc.function.name },
        { providerId: lastProviderId }
      );
      const toolResult = await executeServerTool(tc.function.name, tc.function.arguments || '{}', { log });
      const ms = Date.now() - t0;
      const ok = toolResult && !String(toolResult).startsWith('{"error"') && !String(toolResult).startsWith('{"ok":false');
      await onChunk(
        { type: 'tool_progress', event: 'end', name: tc.function.name, ms, ok: !!ok },
        { providerId: lastProviderId }
      );
      workingMessages.push({
        role: 'tool',
        tool_call_id: tc.id || ('tc-' + Math.random().toString(36).slice(2)),
        content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
      });
    }
  }
  // 达 MAX_ITERATIONS 上限 → emit 显式 error chunk (不再撒谎成 finish:stop)
  log && log('warn', `hit MAX_ITERATIONS=${MAX_ITERATIONS}, emit error chunk`);
  if (lastProviderId) {
    await onChunk(
      { type: 'error', error: 'max_iterations_reached', limit: MAX_ITERATIONS, iterations: iter },
      { providerId: lastProviderId }
    );
  }
  return {
    ok: false,
    providerId: lastProviderId,
    iterations: iter,
    hitMaxIterations: true,
    error: 'max_iterations_reached',
  };
}

export function detectCapability(messages) {
  const result = { vision: false, audio: false };
  for (const m of (messages || [])) {
    const c = m.content;
    if (!Array.isArray(c)) continue;
    for (const part of c) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'image_url' || part.type === 'input_image') result.vision = true;
      if (part.type === 'input_audio' || part.type === 'audio_url') result.audio = true;
    }
  }
  return result;
}

export const __testing__ = {
  _emptyCounters,
};
