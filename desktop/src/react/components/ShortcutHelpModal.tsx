import { useI18n } from '../hooks/use-i18n';
import { useDialogA11y } from '../hooks/use-dialog-a11y';
import styles from './ShortcutHelpModal.module.css';

type ShortcutRow = {
  keys: string[];
  zh: string;
  en: string;
};

const SHORTCUTS: ShortcutRow[] = [
  { keys: ['Cmd/Ctrl', 'K'], zh: '搜索历史对话；侧边栏关闭时聚焦输入框', en: 'Search chat history; focus composer when the sidebar is closed' },
  { keys: ['Cmd/Ctrl', 'Shift', 'N'], zh: '新建会话', en: 'Create a new session' },
  { keys: ['Cmd/Ctrl', '/'], zh: '切换左侧会话栏', en: 'Toggle the session sidebar' },
  { keys: ['Cmd/Ctrl', ','], zh: '打开设置', en: 'Open Settings' },
  { keys: ['Cmd/Ctrl', 'L'], zh: '聚焦输入框', en: 'Focus the composer' },
  { keys: ['Cmd/Ctrl', 'J'], zh: '打开或关闭右侧书桌', en: 'Toggle the desk sidebar' },
  { keys: ['Cmd/Ctrl', 'Shift', 'M'], zh: '切换写作模式', en: 'Toggle writing mode' },
  { keys: ['Cmd/Ctrl', 'Shift', 'L'], zh: '全局唤起语音助手', en: 'Summon the voice assistant globally' },
  { keys: ['Esc'], zh: '停止生成，或关闭预览', en: 'Stop generation, or close preview' },
];

const SLASH_COMMANDS: ShortcutRow[] = [
  { keys: ['/goal'], zh: '设定一个不达成不停的目标', en: 'Set a persistent goal' },
  { keys: ['/plan'], zh: '生成当前工作的短计划', en: 'Create a short execution plan' },
  { keys: ['/clear'], zh: '清空当前对话', en: 'Clear the current chat' },
  { keys: ['/save'], zh: '保存当前内容或输出', en: 'Save current content or output' },
  { keys: ['/diary'], zh: '写入日记/工作记录', en: 'Write a diary or work note' },
  { keys: ['/compact'], zh: '压缩当前上下文', en: 'Compact the current context' },
];

function isChineseLocale(locale?: string) {
  return String(locale || '').toLowerCase().startsWith('zh');
}

function ShortcutRows({ rows, zh }: { rows: ShortcutRow[]; zh: boolean }) {
  return (
    <div className={styles.list}>
      {rows.map((row) => (
        <div className={styles.row} key={`${row.keys.join('+')}-${row.en}`}>
          <span className={styles.keys} aria-label={row.keys.join(' + ')}>
            {row.keys.map((key) => <kbd className={styles.key} key={key}>{key}</kbd>)}
          </span>
          <span className={styles.desc}>{zh ? row.zh : row.en}</span>
        </div>
      ))}
    </div>
  );
}

export function ShortcutHelpModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { locale } = useI18n();
  const zh = isChineseLocale(locale);
  const dialogRef = useDialogA11y<HTMLElement>({ open, onClose });

  if (!open) return null;

  return (
    <div className={styles.overlay} role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        tabIndex={-1}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcut-help-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className={styles.header}>
          <div>
            <h2 className={styles.title} id="shortcut-help-title">
              {zh ? '快捷键和命令' : 'Shortcuts and commands'}
            </h2>
            <p className={styles.subtitle}>
              {zh
                ? '按 Cmd/Ctrl + ? 随时打开。快捷键不会打断正在运行的后台任务。'
                : 'Press Cmd/Ctrl + ? anytime. Shortcuts do not interrupt background tasks.'}
            </p>
          </div>
          <button className={styles.close} type="button" onClick={onClose} aria-label={zh ? '关闭' : 'Close'}>
            ×
          </button>
        </header>
        <div className={styles.body}>
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>{zh ? '键盘快捷键' : 'Keyboard shortcuts'}</h3>
            <ShortcutRows rows={SHORTCUTS} zh={zh} />
          </section>
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>{zh ? 'Slash 命令' : 'Slash commands'}</h3>
            <ShortcutRows rows={SLASH_COMMANDS} zh={zh} />
          </section>
        </div>
      </section>
    </div>
  );
}
