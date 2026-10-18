import fs from 'node:fs';
import { searchDeepSeek } from '../../shared/deepseek-search.js';

export function deepSeekSearchConfigured(): boolean {
  return Boolean(process.env.DEEPSEEK_SEARCH_KEY || process.env.DEEPSEEK_SEARCH_KEY_FILE);
}

export async function searchDeepSeekStructured(query: string, signal?: AbortSignal) {
  const key = process.env.DEEPSEEK_SEARCH_KEY || (process.env.DEEPSEEK_SEARCH_KEY_FILE
    ? fs.readFileSync(process.env.DEEPSEEK_SEARCH_KEY_FILE, 'utf8').trim()
    : '');
  const items = await searchDeepSeek(query, 5, key, signal);
  const summary = items.map(item => `${item.title}\n${item.url}\nPublished: ${item.date || 'unknown'}; retrieved: ${item.retrievedAt}\n${item.snippet}`).join('\n\n');
  return { items, summary };
}
