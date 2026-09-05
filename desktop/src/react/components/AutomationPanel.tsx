import { useCallback, useMemo } from 'react';
import { useDialogA11y } from '../hooks/use-dialog-a11y';
import { useStore } from '../stores';
import { AutomationEditor } from './automation/AutomationEditor';
import { AutomationTemplateLibrary } from './automation/AutomationTemplateLibrary';
import { folderLabel } from './automation/job-utils';
import { useAutomationData } from './automation/useAutomationData';
import { useAutomationDraft } from './automation/useAutomationDraft';
import styles from './AutomationPanel.module.css';

export function AutomationPanel() {
  const activePanel = useStore((state) => state.activePanel);
  const locale = useStore((state) => state.locale || 'zh');
  const selectedFolder = useStore((state) => state.selectedFolder || '');
  const homeFolder = useStore((state) => state.homeFolder || '');
  const currentSessionPath = useStore((state) => state.currentSessionPath);
  const sessions = useStore((state) => state.sessions);
  const isZh = locale.startsWith('zh');
  const translate = window.t;
  const tt = useCallback((key: string, zhText: string, enText: string) => {
    const value = translate ? translate(key) : key;
    return !value || value === key ? (isZh ? zhText : enText) : value;
  }, [isZh, translate]);
  const close = useCallback(() => useStore.getState().setActivePanel(null), []);
  const isOpen = activePanel === 'automation';
  const dialogRef = useDialogA11y({ open: isOpen, onClose: close });

  const currentSession = useMemo(
    () => sessions.find((session) => session.path === currentSessionPath) || null,
    [sessions, currentSessionPath],
  );
  const projectOptions = useMemo(() => {
    const seen = new Set<string>();
    return [selectedFolder, homeFolder, currentSession?.cwd || '']
      .filter(Boolean)
      .map((value) => String(value).trim())
      .filter((value) => value && !seen.has(value) && (seen.add(value), true))
      .map((value) => ({ value, label: folderLabel(value), meta: value }));
  }, [currentSession?.cwd, homeFolder, selectedFolder]);

  const data = useAutomationData({ enabled: isOpen, isZh, tt });
  const draft = useAutomationDraft({ isZh, projectOptions, availableModels: data.availableModels });
  const defaultModelLabel = tt('automation.defaultModel', '默认工作模型', 'Default work model');

  const saveDraft = useCallback(async (runNow: boolean) => {
    const name = draft.name.trim() || (draft.currentTemplate ? (isZh ? draft.currentTemplate.defaultLabelZh : draft.currentTemplate.defaultLabelEn) : '');
    const prompt = draft.prompt.trim() || (draft.currentTemplate ? (isZh ? draft.currentTemplate.promptZh : draft.currentTemplate.promptEn) : '');
    const saved = await data.saveJob({
      editingJobId: draft.editingJobId,
      name,
      prompt,
      project: draft.project,
      model: draft.model,
      schedulePreset: draft.schedulePreset,
      hour: draft.hour,
      minute: draft.minute,
      weeklyDay: draft.weeklyDay,
      customDays: draft.customDays,
      runNow,
      preserveSchedule: draft.preserveSchedule,
      onSaved: draft.acceptSavedJob,
    });
    if (saved.saved && !saved.testError) draft.reset();
  }, [data, draft, isZh]);

  if (!isOpen) return null;
  return (
    <div className={styles.automationOverlay} onClick={close}>
      <div
        ref={dialogRef}
        className={styles.automationDialog}
        role="dialog"
        aria-modal="true"
        aria-label={tt('automation.title', '自动任务', 'Scheduled tasks')}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className={styles.automationDialogHeader}>
          <div className={styles.automationDialogTitleBlock}>
            <div className={styles.automationDialogTitle}>{tt('automation.title', '自动任务', 'Scheduled tasks')}</div>
            <div className={styles.automationDialogSubtitle}>
              {tt(
                'automation.guideDesc',
                '先选一个日常工作模板，再在底部设置项目、时间和模型。创建后，Lynn 会按计划自动执行，并把结果记到活动里；只有提示里明确要求写文件时，才会落到工作区。',
                'Pick a daily-work template, then set the project, schedule, and model at the bottom. Results appear in Activity unless the prompt explicitly writes files into the workspace.',
              )}
            </div>
          </div>
          <div className={styles.automationDialogActions}>
            <button type="button" className={styles.automationGhostBtn} onClick={draft.startCustom}>{isZh ? '新建自定义任务' : 'New custom task'}</button>
            <button type="button" className={styles.automationCloseBtn} onClick={close} aria-label={isZh ? '关闭' : 'Close'}>×</button>
          </div>
        </div>

        <AutomationTemplateLibrary
          jobs={data.jobs}
          availableModels={data.availableModels}
          loading={data.loading}
          loadError={data.loadError}
          selectedTemplateId={draft.selectedTemplateId}
          selectionVersion={draft.selectionVersion}
          editingJobId={draft.editingJobId}
          defaultModelLabel={defaultModelLabel}
          isZh={isZh}
          onRetry={() => void data.loadData()}
          onSelectTemplate={draft.startFromTemplate}
          onToggleJob={(id) => void data.toggleJob(id)}
          onEditJob={draft.editJob}
          onRemoveJob={data.removeJob}
          onRunJobNow={(id) => void data.runJobNow(id)}
          editor={(rootRef) => (
            <AutomationEditor
              rootRef={rootRef}
              draft={draft}
              projectOptions={projectOptions}
              availableModels={data.availableModels}
              defaultModelLabel={defaultModelLabel}
              isZh={isZh}
              saving={data.saving}
              testFailure={data.testFailure?.id === draft.editingJobId ? data.testFailure.message : undefined}
              onSave={(runNow) => void saveDraft(runNow)}
            />
          )}
        />
      </div>
    </div>
  );
}
