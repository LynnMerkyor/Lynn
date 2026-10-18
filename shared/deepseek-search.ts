import { setTimeout as delay } from 'node:timers/promises';

export interface DeepSeekSearchItem {
  title: string;
  url: string;
  snippet: string;
  summary: string;
  content: string;
  date: string | null;
  authority: number | null;
  rerank_score: number | null;
  retrievedAt: string;
}

const starts = new Map<string, number>();

export async function searchDeepSeek(query: string, count: number, apiKey: string, signal?: AbortSignal): Promise<DeepSeekSearchItem[]> {
  const normalized = query.trim();
  if (!normalized || [...normalized].length > 128) throw new Error('DeepSeek Search query must contain 1–128 Unicode characters; provide a shorter query without dropping the place or date.');
  if (!Number.isInteger(count) || count < 1 || count > 50) throw new Error('DeepSeek Search count must be an integer between 1 and 50.');
  if (!apiKey.trim()) throw new Error('DeepSeek Search API key is missing.');
  const deadline = AbortSignal.timeout(10000);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  combined.throwIfAborted();
  const now = Date.now();
  for (const [key, next] of starts) if (next < now) starts.delete(key);
  const start = Math.max(now, starts.get(apiKey) || 0);
  if (start - now > 1500) throw new Error('DeepSeek Search local rate limit; use fallback.');
  starts.set(apiKey, start + 250);
  if (start > now) await delay(start - now, undefined, { signal: combined });
  const response = await fetch('https://api.deepseek.com/v1/tools/search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: normalized, count, need_content: false }),
    signal: combined,
  });
  if (!response.ok) throw new Error(`DeepSeek Search HTTP ${response.status}`);
  const data = await response.json() as { results?: Array<Record<string, unknown>> };
  if (!Array.isArray(data.results)) throw new Error('DeepSeek Search invalid response.');
  const retrievedAt = new Date().toISOString();
  const seen = new Set<string>();
  const items: DeepSeekSearchItem[] = [];
  for (const row of data.results) {
    if (!row || typeof row !== 'object' || typeof row.url !== 'string') continue;
    let url: URL;
    try { url = new URL(row.url); } catch { continue; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || seen.has(row.url)) continue;
    const summary = typeof row.summary === 'string' ? row.summary : '';
    const snippet = typeof row.snippet === 'string' ? row.snippet : '';
    if (!summary.trim() && !snippet.trim()) continue;
    seen.add(row.url);
    items.push({
      title: typeof row.title === 'string' ? row.title : row.url,
      url: row.url,
      snippet: summary || snippet,
      summary,
      content: typeof row.content === 'string' ? row.content : '',
      date: typeof row.date === 'string' ? row.date : null,
      authority: typeof row.authority === 'number' ? row.authority : null,
      rerank_score: typeof row.rerank_score === 'number' ? row.rerank_score : null,
      retrievedAt,
    });
    if (items.length >= count) break;
  }
  if (!items.length) throw new Error('DeepSeek Search returned no usable results.');
  return items;
}
