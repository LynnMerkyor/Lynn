/**
 * ThinkingBlock — 可折叠的思考过程区块
 */

import { memo, useState, useCallback, useEffect, useMemo, useRef, type MouseEvent } from 'react';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import styles from './Chat.module.css';

interface Props {
  content: string;
  sealed: boolean;
  modelLabel?: string | null;
  // #12: explicit capability flag — preferred over modelLabel regex (regex breaks on model rename).
  // Falls back to regex on modelLabel when not provided. Caller can wire from provider meta.
  isLocalProvider?: boolean;
}

const TRANSLATE_CHUNK_CHARS = 2_500; // #29: chunked translate ceiling per request
const MAX_TRANSLATE_CHUNKS = 8;       // #29: cap total chunks (≈ 20K char absolute ceiling)

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

export const ThinkingBlock = memo(function ThinkingBlock({ content, sealed, modelLabel, isLocalProvider }: Props) {
  const t = useMemo(() => window.t ?? ((p: string) => p), []);
  // Keep raw provider thinking opt-in. Some providers stream internal thoughts in
  // English, so default-collapsing prevents that text from reading like the answer.
  const [explicitOpen, setExplicitOpen] = useState<boolean | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [translated, setTranslated] = useState<string | null>(null);
  const [translateBusy, setTranslateBusy] = useState(false);
  const [translateError, setTranslateError] = useState<string | null>(null);
  const startRef = useRef(Date.now());
  // #12: prefer explicit prop; fallback to regex (kept for callers not yet passing the flag)
  // 2026-05-25: 默认回到 9B,正则保留 4B/35B 兼容以覆盖自选 GGUF 和降级档。
  // 同时保留 9B / 35B 的 backward-compat。
  const isLocalModelThinking = isLocalProvider === true
    || (isLocalProvider !== false && /local-qwen|qwen35-4b|qwen35-9b|qwen36-35b|Qwen3(?:\.5)?-(?:4B|9B|35B)|本地\s*(?:4B|9B|35B|Qwen)/i.test(modelLabel || ""));
  const isLocalProgressThinking = isLocalModelThinking || /本地\s*(?:4B|9B|35B|Qwen)|本地模型|llama\.cpp|等待工具/.test(content || "");
  const isLocalColdStartThinking = /首次启动|第一问|暖机|等待首字/.test(content || "");
  // Local cold-start notes are user-facing progress, but raw provider thinking
  // can be long or English. Keep it collapsed unless the user explicitly opens it.
  const open = explicitOpen ?? false;
  const toggle = useCallback(() => setExplicitOpen(v => !(v ?? false)), []);
  const shouldOfferTranslate = sealed && /[A-Za-z]{4,}/.test(content || "");

  useEffect(() => {
    if (sealed) return;
    startRef.current = Date.now();
    const timer = setInterval(() => {
      setElapsed(Date.now() - startRef.current);
    }, 1000);
    return () => clearInterval(timer);
  }, [sealed]);

  useEffect(() => {
    if (sealed) setExplicitOpen(false);
  }, [sealed]);

  useEffect(() => {
    setTranslated(null);
    setTranslateError(null);
  }, [content]);

  // Thinking volume badge — at 100+ TPS heads (StepFun 3.7 Flash) the thinking phase is the
  // dominant wait; show how much reasoning has streamed so the wait reads as progress.
  const charCount = content ? content.length : 0;
  const volumeLabel = charCount >= 200
    ? ` · ${charCount >= 1000 ? `${(charCount / 1000).toFixed(1)}k` : charCount} 字`
    : '';
  const elapsedLabel = !sealed && elapsed >= 2000
    ? ` (${formatElapsed(elapsed)}${volumeLabel})`
    : (sealed && charCount >= 200 ? ` (${charCount >= 1000 ? `${(charCount / 1000).toFixed(1)}k` : charCount} 字)` : '');
  const activeLabel = useMemo(() => {
    if (sealed) return t('thinking.done');
    if (isLocalColdStartThinking && elapsed >= 8_000) return '首轮暖机中，后续会更快';
    if (isLocalModelThinking && elapsed >= 40_000) return '本地模型仍在生成';
    if (isLocalModelThinking && elapsed >= 25_000) return '本地模型正在本机生成';
    if (isLocalProgressThinking && elapsed >= 8_000) return '本地模型正在组织答案';
    if (elapsed >= 8_000) return '正在组织答案';
    return t('thinking.active');
  }, [elapsed, isLocalColdStartThinking, isLocalModelThinking, isLocalProgressThinking, sealed, t]);

  const fallbackBody = useMemo(() => {
    if (sealed || content.trim()) return '';
    if (!isLocalModelThinking) return 'Lynn 正在组织答案。';
    if (elapsed >= 8_000) {
      return '本地模型正在本机生成答案。首次启动后的第一问可能较慢，后续同一会话通常会明显更快。';
    }
    return '本地模型正在本机生成答案，请稍候。';
  }, [content, elapsed, isLocalModelThinking, sealed]);

  const handleTranslateThinking = useCallback(async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!content || translateBusy) return;
    if (!sealed) {
      setTranslateError('思考完成后再翻译。');
      return;
    }
    // #29: chunked translate for long thinking (was: hard reject > 3000)
    setTranslateBusy(true);
    setTranslateError(null);
    setExplicitOpen(true);
    try {
      // Split into ≤ MAX_TRANSLATE_CHUNKS chunks of ≤ TRANSLATE_CHUNK_CHARS each at sentence boundaries
      const splitIntoChunks = (text: string): string[] => {
        if (text.length <= TRANSLATE_CHUNK_CHARS) return [text];
        const chunks: string[] = [];
        let remaining = text;
        while (remaining.length > 0 && chunks.length < MAX_TRANSLATE_CHUNKS) {
          if (remaining.length <= TRANSLATE_CHUNK_CHARS) {
            chunks.push(remaining);
            break;
          }
          // find last sentence boundary within window
          const window = remaining.slice(0, TRANSLATE_CHUNK_CHARS);
          const lastBoundary = Math.max(
            window.lastIndexOf('. '),
            window.lastIndexOf('.\n'),
            window.lastIndexOf('。'),
            window.lastIndexOf('！'),
            window.lastIndexOf('？'),
            window.lastIndexOf('\n\n'),
          );
          const cut = lastBoundary > TRANSLATE_CHUNK_CHARS * 0.5 ? lastBoundary + 1 : TRANSLATE_CHUNK_CHARS;
          chunks.push(remaining.slice(0, cut));
          remaining = remaining.slice(cut).trimStart();
        }
        return chunks;
      };

      const chunks = splitIntoChunks(content);
      const wasTruncated = content.length > TRANSLATE_CHUNK_CHARS * MAX_TRANSLATE_CHUNKS;
      const pieces: string[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const res = await hanaFetch('/api/translate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: chunks[i], targetLanguage: '中文' }),
          timeout: 70_000,
        });
        const data = await res.json().catch(() => null) as { text?: string; error?: string; message?: string } | null;
        if (!res.ok || !data?.text) {
          throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
        }
        pieces.push(data.text);
      }
      const combined = pieces.join('\n\n') + (wasTruncated ? '\n\n[已截至前 ' + (TRANSLATE_CHUNK_CHARS * MAX_TRANSLATE_CHUNKS) + ' 字]' : '');
      if (!combined) throw new Error('translation produced empty result');
      setTranslated(combined);
    } catch (err) {
      setTranslateError(err instanceof Error ? err.message : String(err));
    } finally {
      setTranslateBusy(false);
    }
  }, [content, sealed, translateBusy]);

  return (
    <details
      className={`${styles.thinkingBlock}${sealed ? '' : ` ${styles.thinkingBlockRunning}`}`}
      open={open}
      onToggle={(e) => setExplicitOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className={styles.thinkingBlockSummary} onClick={(e) => { e.preventDefault(); toggle(); }}>
        <span className={`${styles.thinkingBlockArrow}${open ? ` ${styles.thinkingBlockArrowOpen}` : ''}`}>›</span>
        <span className={styles.thinkingBlockLabel}>
          {activeLabel}
          {elapsedLabel}
        </span>
        {shouldOfferTranslate && (
          <button
            className={styles.thinkingTranslateBtn}
            onClick={handleTranslateThinking}
            disabled={translateBusy || !sealed}
            title="把思考内容翻译成中文"
            aria-label="把思考内容翻译成中文"
          >
            {translateBusy ? '翻译中' : '译中文'}
          </button>
        )}
        {!sealed && <span className={styles.thinkingDots}><span /><span /><span /></span>}
      </summary>
      {open && (content || fallbackBody) && (
        <>
          <div className={styles.thinkingBlockBody}>{content || fallbackBody}</div>
          {(translated || translateError) && (
            <div className={styles.thinkingTranslationCard}>
              <div className={styles.translationCardHead}>
                <span>{translateError ? '翻译失败' : '中文译文'}</span>
              </div>
              <div className={styles.translationCardBody}>{translateError || translated}</div>
            </div>
          )}
        </>
      )}
    </details>
  );
});
