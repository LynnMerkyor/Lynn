import styles from './InputArea.module.css';

type Translate = (key: string, vars?: Record<string, string | number>) => string;

interface InputDiscoveryHintsProps {
  inlineFileSuggestion: string | null;
  onDismissAtDiscovery: () => void;
  onDismissInlineHint: () => void;
  onTryAtInjection: () => void;
  onUseInlineAtHint: () => void;
  showAtDiscovery: boolean;
  /** Fleet discoverability: the typed task looks splittable into parallel workers. */
  showFleetHint?: boolean;
  onOpenFleet?: () => void;
  onDismissFleetHint?: () => void;
  t: Translate;
}

export function InputDiscoveryHints({
  inlineFileSuggestion,
  onDismissAtDiscovery,
  onDismissInlineHint,
  onTryAtInjection,
  onUseInlineAtHint,
  showAtDiscovery,
  showFleetHint,
  onOpenFleet,
  onDismissFleetHint,
  t,
}: InputDiscoveryHintsProps) {
  return (
    <>
      {showFleetHint && onOpenFleet && (
        <div className={styles['at-inline-hint']}>
          <button type="button" className={styles['at-inline-hint-main']} onClick={onOpenFleet}>
            <span>{t('fleet.chatHint.text') || '⚡ 这个任务看起来可以拆给多个并行 worker 同时干'}</span>
            <span className={styles['at-inline-hint-action']}>{t('fleet.chatHint.action') || '去布置'}</span>
          </button>
          <button
            type="button"
            className={styles['at-inline-hint-dismiss']}
            onClick={onDismissFleetHint}
            aria-label={t('common.close') || '关闭'}
            title={t('common.close') || '关闭'}
          >
            ×
          </button>
        </div>
      )}
      {showAtDiscovery && (
        <div className={styles['at-discovery-row']}>
          <button type="button" className={styles['at-discovery-pill']} onClick={onTryAtInjection}>
            <span className={styles['at-discovery-badge']}>@</span>
            <span className={styles['at-discovery-copy']}>
              <strong>{t('input.atDiscovery.title') || '试试 @ 引用文件或文件夹'}</strong>
              <span>{t('input.atDiscovery.subtitle') || '例如：@App.tsx 帮我看这段路由'}</span>
            </span>
          </button>
          <button
            type="button"
            className={styles['at-discovery-dismiss']}
            onClick={onDismissAtDiscovery}
            aria-label={t('common.close') || '关闭'}
            title={t('common.close') || '关闭'}
          >
            ×
          </button>
        </div>
      )}
      {inlineFileSuggestion && (
        <div className={styles['at-inline-hint']}>
          <button type="button" className={styles['at-inline-hint-main']} onClick={onUseInlineAtHint}>
            <span>{t('input.atDiscovery.inlineHint', { name: inlineFileSuggestion }) || `💡 输入 @${inlineFileSuggestion} 可以直接让 Lynn 看这个文件`}</span>
            <span className={styles['at-inline-hint-action']}>{t('input.atDiscovery.inlineAction') || '改成 @ 引用'}</span>
          </button>
          <button
            type="button"
            className={styles['at-inline-hint-dismiss']}
            onClick={onDismissInlineHint}
            aria-label={t('common.close') || '关闭'}
            title={t('common.close') || '关闭'}
          >
            ×
          </button>
        </div>
      )}
    </>
  );
}
