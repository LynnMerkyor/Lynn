import type { Ref } from 'react';
import { DaySelector, TimePicker } from './ScheduleControls';
import type { ModelOption } from './types';
import type { AutomationDraft, ProjectOption } from './useAutomationDraft';
import styles from '../AutomationPanel.module.css';

export function AutomationEditor({
  rootRef,
  draft,
  projectOptions,
  availableModels,
  defaultModelLabel,
  isZh,
  saving,
  testFailure,
  onSave,
}: {
  rootRef?: Ref<HTMLDivElement>;
  draft: AutomationDraft;
  projectOptions: ProjectOption[];
  availableModels: ModelOption[];
  defaultModelLabel: string;
  isZh: boolean;
  saving: boolean;
  testFailure?: string;
  onSave: (runNow: boolean) => void;
}) {
  const canSave = Boolean((draft.name.trim() || draft.currentTemplate) && (draft.prompt.trim() || draft.currentTemplate));
  return (
    <div ref={rootRef} className={styles.automationComposer}>
      <div className={styles.automationComposerTop}>
        <div className={styles.automationComposerTitle}>
          {draft.editingJobId
            ? (isZh ? '编辑自动任务' : 'Edit task')
            : draft.currentTemplate
              ? (isZh ? `使用模板：${draft.currentTemplate.zhTitle}` : `Use template: ${draft.currentTemplate.enTitle}`)
              : (isZh ? '先选一个模板，或新建自定义任务' : 'Pick a template or create a custom task')}
        </div>
        <div className={styles.automationComposerHint}>
          {isZh
            ? '模板任务默认已经带好目标和输出格式。通常只需要选项目、时间和模型；只有你想改写模板时，才需要展开下面的任务内容。'
            : 'Template tasks already come with a goal and output shape. Usually you only need project, schedule, and model here; only expand the prompt when you want to customize the template.'}
        </div>
      </div>

      <div className={styles.automationComposerFields}>
        {!draft.templateMode && (
          <label className={styles.automationField}>
            <span className={styles.automationFieldLabel}>{isZh ? '任务名称' : 'Task name'}</span>
            <input className={styles.automationFieldInput} value={draft.name} onChange={(event) => draft.setName(event.target.value)} placeholder={isZh ? '例如：工作日项目巡检' : 'e.g. Weekday project review'} />
          </label>
        )}
        <label className={styles.automationField}>
          <span className={styles.automationFieldLabel}>{isZh ? '项目' : 'Project'}</span>
          <select className={styles.automationFieldSelect} value={draft.project} onChange={(event) => draft.setProject(event.target.value)}>
            {draft.project && !projectOptions.some((option) => option.value === draft.project) && <option value={draft.project}>{draft.project}</option>}
            {projectOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label && option.label !== option.meta ? `${option.label} · ${option.meta}` : option.meta}
              </option>
            ))}
          </select>
        </label>
        {!draft.scheduleLocked && <label className={styles.automationField}>
          <span className={styles.automationFieldLabel}>{isZh ? '频率' : 'Schedule'}</span>
          <select className={styles.automationFieldSelect} value={draft.schedulePreset} onChange={(event) => draft.setSchedulePreset(event.target.value as typeof draft.schedulePreset)}>
            <option value="daily">{isZh ? '每天' : 'Daily'}</option>
            <option value="weekdays">{isZh ? '工作日' : 'Weekdays'}</option>
            <option value="weekly">{isZh ? '每周' : 'Weekly'}</option>
            <option value="custom">{isZh ? '定制' : 'Custom'}</option>
          </select>
        </label>}
        <label className={styles.automationField}>
          <span className={styles.automationFieldLabel}>{isZh ? '模型' : 'Model'}</span>
          <select className={styles.automationFieldSelect} value={draft.model} onChange={(event) => draft.setModel(event.target.value)}>
            <option value="">{defaultModelLabel}</option>
            {availableModels.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        {!draft.scheduleLocked && <div className={styles.automationField}>
          <span className={styles.automationFieldLabel}>{isZh ? '时间' : 'Time'}</span>
          <TimePicker hour={draft.hour} minute={draft.minute} onChange={(hour, minute) => {
            draft.setHour(hour);
            draft.setMinute(minute);
          }} />
        </div>}
      </div>

      {draft.scheduleLocked && <div className={styles.automationPanelNotice} role="note">
        <strong>{isZh ? '保留原有执行计划' : 'Original schedule preserved'}</strong>
        <p><code>{String(draft.originalSchedule?.schedule)}</code> ({draft.originalSchedule?.type || 'cron'})</p>
        <p>{isZh ? '此计划不能用简单时间选项完整表达。修改名称、内容、项目或模型不会改变执行时间。' : 'This rule cannot be represented by the simple controls. Editing other fields will not change its schedule.'}</p>
      </div>}

      {draft.templateMode && draft.currentTemplate && (
        <div className={styles.automationPanelNotice} style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>{isZh ? draft.currentTemplate.zhTitle : draft.currentTemplate.enTitle}</div>
          <div style={{ marginBottom: 8 }}>{isZh ? draft.currentTemplate.zhDesc : draft.currentTemplate.enDesc}</div>
          <button type="button" className={styles.automationLinkBtn} onClick={() => draft.setShowTemplatePrompt((value) => !value)}>
            {draft.showTemplatePrompt ? (isZh ? '收起模板内容' : 'Hide template details') : (isZh ? '查看模板内容' : 'View template details')}
          </button>
        </div>
      )}

      {!draft.scheduleLocked && (draft.schedulePreset === 'weekly' || draft.schedulePreset === 'custom') && (
        <div className={styles.automationComposerDays}>
          <div className={styles.automationFieldLabel}>{draft.schedulePreset === 'weekly' ? (isZh ? '每周哪天' : 'Day of week') : (isZh ? '定制日期' : 'Custom days')}</div>
          <DaySelector
            isZh={isZh}
            selected={draft.schedulePreset === 'weekly' ? [draft.weeklyDay] : draft.customDays}
            single={draft.schedulePreset === 'weekly'}
            onChange={(days) => {
              if (draft.schedulePreset === 'weekly') draft.setWeeklyDay(days[0] ?? 1);
              else draft.setCustomDays(days);
            }}
          />
        </div>
      )}

      {(!draft.templateMode || draft.showTemplatePrompt) && (
        <label className={`${styles.automationField} ${styles.automationFieldGrow}`}>
          <span className={styles.automationFieldLabel}>{isZh ? '任务内容' : 'Prompt'}</span>
          <textarea className={styles.automationFieldTextarea} rows={4} value={draft.prompt} onChange={(event) => draft.setPrompt(event.target.value)} placeholder={isZh ? '写下这条自动任务要替你做什么' : 'Describe what this scheduled task should do'} />
        </label>
      )}

      {testFailure && <div className={styles.automationPanelNotice} role="alert">
        {isZh ? `任务已保存，但测试未启动：${testFailure}。再次保存并测试不会重复创建。` : `Task saved, but the test did not start: ${testFailure}. Retrying will not create a duplicate.`}
      </div>}
      <div className={styles.automationComposerActions}>
        <button type="button" className={styles.automationGhostBtn} onClick={draft.reset}>{isZh ? '清空' : 'Clear'}</button>
        <button type="button" className={styles.automationGhostBtn} disabled={saving || !canSave} onClick={() => onSave(true)}>
          {saving ? (isZh ? '处理中…' : 'Saving...') : draft.editingJobId ? (isZh ? '保存并测试' : 'Save & test') : (isZh ? '创建并测试' : 'Create & test')}
        </button>
        <button type="button" className={styles.automationPrimaryBtn} disabled={saving || !canSave} onClick={() => onSave(false)}>
          {saving ? (isZh ? '处理中…' : 'Saving...') : draft.editingJobId ? (isZh ? '保存修改' : 'Save changes') : (isZh ? '创建自动任务' : 'Create task')}
        </button>
      </div>
    </div>
  );
}
