import { useCallback, useEffect, useMemo, useState } from 'react';
import { inferSchedulePreset, parseCronDays, parseCronTime, type SchedulePreset } from './cron-utils';
import { resolveJobModelValue } from './job-utils';
import { TEMPLATES, type TemplateDefinition } from './templates';
import type { CronJob, ModelOption } from './types';

export interface ProjectOption {
  value: string;
  label: string;
  meta: string;
}

export function useAutomationDraft({
  isZh,
  projectOptions,
  availableModels,
}: {
  isZh: boolean;
  projectOptions: ProjectOption[];
  availableModels: ModelOption[];
}) {
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [editingJobId, setEditingJobId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [project, setProject] = useState('');
  const [model, setModel] = useState('');
  const [schedulePreset, setSchedulePreset] = useState<SchedulePreset>('daily');
  const [hour, setHour] = useState('09');
  const [minute, setMinute] = useState('00');
  const [weeklyDay, setWeeklyDay] = useState(1);
  const [customDays, setCustomDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [showTemplatePrompt, setShowTemplatePrompt] = useState(false);

  const currentTemplate = useMemo(
    () => selectedTemplateId ? TEMPLATES.find((template) => template.id === selectedTemplateId) || null : null,
    [selectedTemplateId],
  );
  const templateMode = Boolean(currentTemplate) && !editingJobId;

  const reset = useCallback(() => {
    setSelectedTemplateId(null);
    setEditingJobId(null);
    setShowTemplatePrompt(false);
    setName('');
    setPrompt('');
    setModel('');
    setProject(projectOptions[0]?.value || '');
    setSchedulePreset('daily');
    setHour('09');
    setMinute('00');
    setWeeklyDay(1);
    setCustomDays([1, 2, 3, 4, 5]);
  }, [projectOptions]);

  useEffect(() => {
    if (!project) setProject(projectOptions[0]?.value || '');
  }, [project, projectOptions]);

  const startFromTemplate = useCallback((template: TemplateDefinition) => {
    setSelectedTemplateId(template.id);
    setEditingJobId(null);
    setShowTemplatePrompt(false);
    setName(isZh ? template.defaultLabelZh : template.defaultLabelEn);
    setPrompt(isZh ? template.promptZh : template.promptEn);
    setProject(projectOptions[0]?.value || '');
    setModel('');
    setSchedulePreset(template.defaultPreset);
    setHour(template.defaultHour);
    setMinute(template.defaultMinute);
    setWeeklyDay(template.defaultWeeklyDay ?? 1);
    setCustomDays(template.defaultDays || [1, 2, 3, 4, 5]);
  }, [isZh, projectOptions]);

  const startCustom = useCallback(() => {
    setSelectedTemplateId('custom');
    setEditingJobId(null);
    setShowTemplatePrompt(true);
    setName(isZh ? '自定义自动任务' : 'Custom task');
    setPrompt('');
    setProject(projectOptions[0]?.value || '');
    setModel('');
    setSchedulePreset('daily');
    setHour('09');
    setMinute('00');
    setWeeklyDay(1);
    setCustomDays([1, 2, 3, 4, 5]);
  }, [isZh, projectOptions]);

  const editJob = useCallback((job: CronJob) => {
    const cronTime = parseCronTime(job.schedule) || { hour: '09', minute: '00' };
    const cronDays = parseCronDays(job.schedule);
    setSelectedTemplateId(null);
    setEditingJobId(job.id);
    setShowTemplatePrompt(true);
    setName(job.label || '');
    setPrompt(job.prompt || '');
    setProject(job.workspace || projectOptions[0]?.value || '');
    setModel(resolveJobModelValue(job.model, availableModels));
    setSchedulePreset(inferSchedulePreset(job.schedule));
    setHour(cronTime.hour);
    setMinute(cronTime.minute);
    setWeeklyDay(cronDays.find((day) => day >= 0 && day <= 6) ?? 1);
    setCustomDays(cronDays.length > 0 ? cronDays : [1, 2, 3, 4, 5]);
  }, [availableModels, projectOptions]);

  return {
    selectedTemplateId,
    editingJobId,
    name,
    prompt,
    project,
    model,
    schedulePreset,
    hour,
    minute,
    weeklyDay,
    customDays,
    showTemplatePrompt,
    currentTemplate,
    templateMode,
    setName,
    setPrompt,
    setProject,
    setModel,
    setSchedulePreset,
    setHour,
    setMinute,
    setWeeklyDay,
    setCustomDays,
    setShowTemplatePrompt,
    reset,
    startFromTemplate,
    startCustom,
    editJob,
  };
}

export type AutomationDraft = ReturnType<typeof useAutomationDraft>;
