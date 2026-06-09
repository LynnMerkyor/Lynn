#!/usr/bin/env node
// @ts-check
/**
 * Brain provider connectivity gate.
 *
 * This gate checks the product API surfaces directly, not just local mocks:
 * - StepFun executor chat route
 * - GLM coding/executor route
 * - MiMo paid web-search route (api.xiaomimimo.com, not expired Token Plan LLM)
 *
 * Missing keys are skipped by default; pass --require to fail on missing or
 * unhealthy configured production keys.
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const REQUIRE = args.includes('--require');
const JSON_OUT = valueAfter('--json');
const ONLY_VALUE = valueAfter('--only');
const ONLY = ONLY_VALUE ? ONLY_VALUE.split(',').map((s) => s.trim()).filter(Boolean) : null;

loadEnvFile();

function valueAfter(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : '';
}

function loadEnvFile() {
  const candidates = [
    process.env.BRAIN_V2_ENV_FILE,
    '/opt/lobster-brain-v2/.env',
    path.join(process.env.HOME || '', '.lynn/brain.env'),
    '.env',
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const s = line.trim();
        if (!s || s.startsWith('#') || !s.includes('=')) continue;
        const [k, ...rest] = s.split('=');
        if (!process.env[k]) process.env[k] = rest.join('=').trim().replace(/^["']|["']$/g, '');
      }
      return file;
    } catch {
      // Keep probing other candidates.
    }
  }
  return '';
}

function envFirst(names) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return '';
}

async function timedJson(url, init, timeoutMs) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    return { ok: res.ok, status: res.status, json, text, ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, status: 0, text: '', error: err?.message || String(err), ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

function chatBody(model, prompt, maxTokens = 16) {
  return {
    model,
    messages: [{ role: 'user', content: prompt }],
    stream: false,
    max_tokens: maxTokens,
  };
}

function textFromChat(data) {
  return String(data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || '').trim();
}

const providers = [
  {
    id: 'stepfun',
    label: 'StepFun 3.7 Flash',
    key: envFirst(['STEP37_KEY', 'STEP_KEY', 'STEPFUN_KEY']),
    base: envFirst(['STEP37_BASE', 'STEP_BASE', 'STEPFUN_BASE']) || 'https://api.stepfun.com/step_plan/v1',
    model: envFirst(['STEP37_MODEL', 'STEP_MODEL', 'STEPFUN_MODEL']) || 'step-3.7-flash',
    timeoutMs: 20_000,
    async run(p) {
      const res = await timedJson(`${p.base.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.key}` },
        body: JSON.stringify(chatBody(p.model, '请直接输出 OK 两个字母，不要解释。', 64)),
      }, p.timeoutMs);
      const text = textFromChat(res.json);
      return { ...res, usable: res.ok && /OK/i.test(text), evidence: text.slice(0, 80) };
    },
  },
  {
    id: 'glm',
    label: 'GLM-5-Turbo',
    key: envFirst(['ZHIPU_KEY', 'GLM_KEY']),
    base: envFirst(['ZHIPU_CODING_BASE', 'GLM_BASE']) || 'https://open.bigmodel.cn/api/coding/paas/v4',
    model: envFirst(['ZHIPU_CODING_TURBO_MODEL', 'GLM_MODEL']) || 'GLM-5-Turbo',
    optional: true,
    timeoutMs: 25_000,
    async run(p) {
      const res = await timedJson(`${p.base.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.key}` },
        body: JSON.stringify(chatBody(p.model, '只输出 OK 两个字母。', 16)),
      }, p.timeoutMs);
      const text = textFromChat(res.json);
      return { ...res, usable: res.ok && /OK/i.test(text), evidence: text.slice(0, 80) };
    },
  },
  {
    id: 'mimo-search',
    label: 'MiMo Paid Search',
    key: envFirst(['MIMO_SEARCH_KEY', 'MIMO_KEY']),
    base: envFirst(['MIMO_SEARCH_BASE']) || 'https://api.xiaomimimo.com/v1',
    model: envFirst(['MIMO_SEARCH_MODEL']) || 'mimo-v2.5-pro',
    optional: true,
    timeoutMs: 45_000,
    async run(p) {
      const res = await timedJson(`${p.base.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': p.key },
        body: JSON.stringify({
          model: p.model,
          messages: [{ role: 'user', content: '搜索今天国际金价，给出一条带来源的简短结论。' }],
          tools: [{ type: 'web_search', max_keyword: 5, force_search: true }],
          stream: false,
          max_tokens: 512,
        }),
      }, p.timeoutMs);
      const msg = res.json?.choices?.[0]?.message;
      const annotations = Array.isArray(msg?.annotations) ? msg.annotations : [];
      const citations = annotations.filter((a) => a?.type === 'url_citation' && a?.url);
      const text = String(msg?.content || '').trim();
      return {
        ...res,
        usable: res.ok && (citations.length > 0 || /http|来源|金价|gold/i.test(text)),
        evidence: citations[0]?.url || text.slice(0, 80),
        citations: citations.length,
      };
    },
  },
  {
    id: 'deepseek',
    label: 'DeepSeek V4 Flash',
    key: envFirst(['DEEPSEEK_KEY']),
    base: envFirst(['DEEPSEEK_BASE']) || 'https://api.deepseek.com/v1',
    model: envFirst(['DEEPSEEK_MODEL']) || 'deepseek-v4-flash',
    optional: true,
    timeoutMs: 20_000,
    async run(p) {
      const res = await timedJson(`${p.base.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.key}` },
        body: JSON.stringify(chatBody(p.model, '只输出 OK 两个字母。', 16)),
      }, p.timeoutMs);
      const text = textFromChat(res.json);
      return { ...res, usable: res.ok && /OK/i.test(text), evidence: text.slice(0, 80) };
    },
  },
];

const selected = providers.filter((p) => !ONLY || ONLY.includes(p.id));
const rows = [];
for (const provider of selected) {
  if (!provider.key) {
    rows.push({ id: provider.id, label: provider.label, ok: false, skipped: true, reason: 'API key missing' });
    continue;
  }
  process.stderr.write(`checking ${provider.label}... `);
  const result = await provider.run(provider);
  const ok = Boolean(result.usable);
  rows.push({
    id: provider.id,
      label: provider.label,
      ok,
      optional: Boolean(provider.optional),
      status: result.status,
    ms: result.ms,
    evidence: result.evidence,
    citations: result.citations,
    reason: ok ? '' : (result.error || result.text || `HTTP ${result.status}`).slice(0, 180),
  });
  process.stderr.write(ok ? `OK ${result.ms}ms\n` : `FAIL ${result.status || ''} ${result.error || ''}\n`);
}

const failures = rows.filter((row) => !row.ok && !(row.skipped && !REQUIRE) && !(row.optional && !REQUIRE));
console.log(format(rows));
if (JSON_OUT) {
  fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
  fs.writeFileSync(JSON_OUT, JSON.stringify({ ts: new Date().toISOString(), rows }, null, 2));
}
process.exit(failures.length ? 1 : 0);

function format(rows) {
  const lines = ['Brain API connectivity gate', ''];
  for (const row of rows) {
    if (row.skipped) {
      lines.push(`${row.label}: ${REQUIRE ? 'FAIL' : 'skip'} (${row.reason})`);
      continue;
    }
    const extra = row.citations != null ? ` citations=${row.citations}` : '';
    const evidence = row.evidence ? ` evidence=${row.evidence}` : '';
    const status = row.ok ? 'OK' : (row.optional && !REQUIRE ? 'WARN' : 'FAIL');
    lines.push(`${row.label}: ${status} ${row.ms || '--'}ms${extra}${evidence}`);
  }
  return lines.join('\n');
}
