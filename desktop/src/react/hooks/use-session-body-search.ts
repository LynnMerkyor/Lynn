import { useEffect, useRef, useState } from 'react';
import { hanaFetch } from './use-hana-fetch';

export function useSessionBodySearch(query: string, revision: unknown) {
  const [result, setResult] = useState<{ query: string; snippets: Record<string, string>; loading: boolean; incomplete: boolean; error: boolean }>({ query: '', snippets: {}, loading: false, incomplete: false, error: false });
  const sequence = useRef(0);
  useEffect(() => {
    const requestId = ++sequence.current;
    const q = query.trim();
    if (!q) { setResult({ query: q, snippets: {}, loading: false, incomplete: false, error: false }); return; }
    setResult({ query: q, snippets: {}, loading: true, incomplete: false, error: false });
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await hanaFetch(`/api/sessions/search?q=${encodeURIComponent(q)}`, { signal: controller.signal });
        const data = await response.json();
        if (sequence.current !== requestId || controller.signal.aborted) return;
        setResult({ query: q, snippets: Object.fromEntries((data.hits || []).map((hit: { path: string; snippet: string }) => [hit.path, hit.snippet])), loading: false, incomplete: !!(data.skipped || data.truncated), error: false });
      } catch { if (sequence.current === requestId && !controller.signal.aborted) setResult({ query: q, snippets: {}, loading: false, incomplete: false, error: true }); }
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, revision]);
  return result.query === query.trim() ? result : { query, snippets: {}, loading: !!query.trim(), incomplete: false, error: false };
}
