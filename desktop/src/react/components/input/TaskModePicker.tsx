/**
 * TaskModePicker — 任务模式选择器
 *
 * 输入框左下角的芯片按钮，点击展开下拉面板。
 * 用户在面板里选模式（自动/小说/社媒/代码/...）+ 看 slash 命令。
 */

import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { useStore } from '../../stores';
import {
  TASK_MODES,
  CATEGORY_LABELS,
  getModesByCategory,
  getModeById,
  type TaskMode,
  type TaskModeCategory,
} from '../../config/task-modes';
import styles from './TaskModePicker.module.css';

export const TaskModePicker = memo(function TaskModePicker() {
  const taskModeId = useStore(s => s.taskModeId);
  const open = useStore(s => s.taskModePickerOpen);
  const setTaskModeId = useStore(s => s.setTaskModeId);
  const setOpen = useStore(s => s.setTaskModePickerOpen);
  const setComposerText = useStore(s => s.setComposerText);
  const requestInputFocus = useStore(s => s.requestInputFocus);
  const isZh = String(document?.documentElement?.lang || '').startsWith('zh');

  const panelRef = useRef<HTMLDivElement>(null);

  const currentMode = getModeById(taskModeId) || TASK_MODES[0];

  // 分组
  const grouped = useMemo(() => ({
    auto: getModesByCategory('auto'),
    writing: getModesByCategory('writing'),
    work: getModesByCategory('work'),
    study: getModesByCategory('study'),
  }), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  const togglePanel = useCallback(() => setOpen(!open), [open, setOpen]);
  const closePanel = useCallback(() => setOpen(false), [setOpen]);

  const handleSelectMode = useCallback((id: string) => {
    setTaskModeId(id);
  }, [setTaskModeId]);

  const handleSlashClick = useCallback((cmd: string) => {
    setComposerText(cmd + ' ');
    setOpen(false);
    requestInputFocus();
  }, [setComposerText, setOpen, requestInputFocus]);

  const renderGroup = (category: TaskModeCategory, modes: TaskMode[]) => {
    if (modes.length === 0) return null;
    const label = CATEGORY_LABELS[category];
    return (
      <div key={category} className={styles.group}>
        {label && <div className={styles['group-label']}>{label}</div>}
        {modes.map(mode => (
          <div
            key={mode.id}
            className={`${styles.item}${mode.id === taskModeId ? ` ${styles['item-active']}` : ''}`}
            onClick={() => handleSelectMode(mode.id)}
          >
            <span className={styles['item-emoji']}>{mode.emoji}</span>
            <div className={styles['item-text']}>
              <span className={styles['item-name']}>{mode.name}</span>
              <span className={styles['item-subtitle']}>{mode.subtitle}</span>
            </div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className={styles['picker-wrap']}>
      <button
        type="button"
        className={`${styles.chip}${taskModeId !== 'auto' ? ` ${styles['chip-active']}` : ''}`}
        onClick={togglePanel}
        title={isZh ? '任务模式' : 'Task mode'}
        aria-haspopup="true"
        aria-expanded={open}
      >
        <span className={styles['chip-emoji']}>{currentMode.emoji}</span>
        <span>{currentMode.name}</span>
        <span className={styles['chip-arrow']}>▾</span>
      </button>

      {open && (
        <>
          <div className={styles['panel-overlay']} onClick={closePanel} />
          <div ref={panelRef} className={styles.panel}>
            <div className={styles['panel-title']}>
              <div className={styles['panel-avatar']}>{currentMode.emoji}</div>
            </div>

            {renderGroup('auto', grouped.auto)}
            {renderGroup('writing', grouped.writing)}
            {renderGroup('work', grouped.work)}
            {renderGroup('study', grouped.study)}

            {/* 当前模式详情 */}
            {taskModeId !== 'auto' && (
              <div className={styles['mode-detail']}>
                <div className={styles['mode-detail-title']}>
                  {currentMode.emoji} {currentMode.name} · {currentMode.subtitle}
                </div>
                {currentMode.persona && (
                  <div className={styles['mode-detail-subtitle']}>
                    {isZh ? '已启用专属人设，发送消息时自动注入' : 'Persona active, auto-injected'}
                  </div>
                )}
              </div>
            )}

            {/* Slash 命令（如果当前模式有） */}
            {currentMode.slashCommands && currentMode.slashCommands.length > 0 && (
              <>
                <div className={styles['slash-title']}>{isZh ? 'Slash 命令' : 'Slash Commands'}</div>
                <div className={styles['slash-chips']}>
                  {currentMode.slashCommands.map(sc => (
                    <button
                      key={sc.cmd}
                      type="button"
                      className={styles['slash-chip']}
                      onClick={() => handleSlashClick(sc.cmd)}
                      title={sc.label}
                    >
                      {sc.cmd}
                    </button>
                  ))}
                </div>
              </>
            )}

          </div>
        </>
      )}
    </div>
  );
});
