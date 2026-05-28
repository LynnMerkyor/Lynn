import { useCallback } from 'react';
import { useStore } from '../../stores';
import { enterWritingMode, exitWritingMode } from '../../hooks/use-writing-preview';

export function WritingModeToggle() {
  const writingMode = useStore(s => s.writingMode);
  const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || '');
  const kbd = isMac ? '⇧⌘M' : 'Ctrl+Shift+M';
  const isZh = String(document?.documentElement?.lang || '').startsWith('zh');
  const title = writingMode
    ? (isZh ? `退出写作模式 (${kbd})` : `Exit writing mode (${kbd})`)
    : (isZh ? `进入写作模式 (${kbd}) — 加宽聊天 + 自动 MD 预览` : `Writing mode (${kbd}) — wider chat + auto MD preview`);

  const toggle = useCallback(() => {
    if (writingMode) exitWritingMode();
    else enterWritingMode();
  }, [writingMode]);

  return (
    <button
      type="button"
      onClick={toggle}
      title={title}
      aria-pressed={writingMode}
      aria-label={isZh ? '写作模式' : 'Writing mode'}
      style={{
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 26,
        height: 26,
        padding: 0,
        border: `1px solid ${writingMode ? 'var(--accent)' : 'rgba(var(--accent-rgb), 0.14)'}`,
        borderRadius: 'var(--radius-sm, 6px)',
        background: writingMode ? 'rgba(var(--accent-rgb), 0.12)' : 'transparent',
        color: writingMode ? 'var(--accent)' : 'var(--text-muted)',
        cursor: 'pointer',
        transition: 'all 0.15s',
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
      </svg>
    </button>
  );
}
