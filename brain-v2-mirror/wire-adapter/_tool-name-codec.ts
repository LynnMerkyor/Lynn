// @ts-nocheck
// Brain v2 · wire-adapter tool-name codec
//
// 2026-06-10 fix: some OpenAI-wire providers (DeepSeek) reject function names that
// don't match ^[a-zA-Z0-9_-]+$ → HTTP 400 "Invalid 'tools[N].function.name'". Non-
// conforming names leak in from MCP servers / client tools (CJK, dots, spaces). When
// that tool sits anywhere in the merged tool list, the whole fallback request to
// DeepSeek 400s, silently disabling those lanes (StepFun is lenient and accepts them,
// so the primary still works — but the cascade loses its escape hatch).
//
// Fix is purely at the wire boundary: rewrite non-conforming names to a safe,
// deterministic, collision-resistant form on the way OUT (tool defs + historical
// assistant tool_calls in messages), and restore the original name on tool_call
// deltas coming BACK — so the rest of the brain pipeline (dispatch / client-forward)
// only ever sees original names and is untouched. Conforming names pass through
// verbatim (zero behavior change for the common case).

import crypto from 'node:crypto';

const SAFE_RE = /^[a-zA-Z0-9_-]+$/;
const MAX_NAME_LEN = 64; // OpenAI/DeepSeek function-name length ceiling

// Telemetry: log each distinct non-conforming tool name once, so the offending
// skill/MCP tool can be identified (it's the one DeepSeek would have 400'd on).
const _loggedBadNames = new Set();
function _noteBadName(orig, safe) {
  if (_loggedBadNames.has(orig)) return;
  _loggedBadNames.add(orig);
  try { console.warn('[tool-name-codec] non-conforming tool name sanitized: ' + JSON.stringify(String(orig)) + ' -> ' + safe); } catch { /* ignore */ }
}

export function isWireSafeToolName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= MAX_NAME_LEN && SAFE_RE.test(name);
}

// Deterministic safe name for a non-conforming original. Stable (same input → same
// output, so naming stays consistent across turns and across the tools/messages of one
// request), collision-resistant (8-hex sha256 suffix), always matches SAFE_RE, ≤64 chars.
export function toSafeToolName(orig) {
  const base = String(orig)
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '')
    .slice(0, 40);
  const hash = crypto.createHash('sha256').update(String(orig)).digest('hex').slice(0, 8);
  return base ? `mcp_${base}_${hash}` : `mcp_${hash}`;
}

// Sanitize a tools array for the wire. Returns the original array untouched (and
// restore=null) when every name is already safe — the hot path allocates nothing.
// Otherwise returns a shallow-rewritten copy + a Map<safeName, originalName>.
export function sanitizeToolsForWire(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return { tools, restore: null };
  const restore = new Map();
  let changed = false;
  const out = tools.map((t) => {
    const name = t?.function?.name;
    if (typeof name !== 'string' || isWireSafeToolName(name)) return t;
    const safe = toSafeToolName(name);
    _noteBadName(name, safe);
    restore.set(safe, name);
    changed = true;
    return { ...t, function: { ...t.function, name: safe } };
  });
  return changed ? { tools: out, restore } : { tools, restore: null };
}

// Sanitize tool_call function names inside outgoing messages (historical assistant
// tool_calls). Same deterministic mapping as the tools array, so a provider sees one
// consistent name for a given tool in both its definition and the call history. No
// restore needed — these are input, not model output. Returns the original array when
// nothing needs rewriting.
export function sanitizeMessagesForWire(messages) {
  if (!Array.isArray(messages)) return messages;
  let changed = false;
  const out = messages.map((m) => {
    if (!m || !Array.isArray(m.tool_calls) || m.tool_calls.length === 0) return m;
    let mChanged = false;
    const tcs = m.tool_calls.map((c) => {
      const n = c?.function?.name;
      if (typeof n === 'string' && !isWireSafeToolName(n)) {
        const safe = toSafeToolName(n);
        _noteBadName(n, safe);
        mChanged = true;
        changed = true;
        return { ...c, function: { ...c.function, name: safe } };
      }
      return c;
    });
    return mChanged ? { ...m, tool_calls: tcs } : m;
  });
  return changed ? out : messages;
}

// Restore original names on a streamed tool_call_delta chunk. No-op unless a restore
// map is present and the chunk carries a name we rewrote. (OpenAI-wire providers send
// the full function name in a single delta, so a direct map lookup is sufficient.)
export function restoreToolNameInChunk(chunk, restore) {
  if (!restore || restore.size === 0) return chunk;
  if (!chunk || chunk.type !== 'tool_call_delta' || !Array.isArray(chunk.delta)) return chunk;
  let changed = false;
  const delta = chunk.delta.map((tc) => {
    const n = tc?.function?.name;
    if (typeof n === 'string' && restore.has(n)) {
      changed = true;
      return { ...tc, function: { ...tc.function, name: restore.get(n) } };
    }
    return tc;
  });
  return changed ? { ...chunk, delta } : chunk;
}
