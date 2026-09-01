import { useCallback, useEffect, useState } from 'react';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useStore } from '../../stores';
import { buildAutomationModelOptions } from '../AutomationPanel.helpers';
import { buildScheduleFromPreset, type SchedulePreset } from './cron-utils';
import type { CronJob, ModelOption } from './types';

type Translate = (key: string, zhText: string, enText: string) => string;

export interface SaveAutomationInput {
  editingJobId: string | null;
  name: string;
  prompt: string;
  project: string;
  model: string;
  schedulePreset: SchedulePreset;
  hour: string;
  minute: string;
  weeklyDay: number;
  customDays: number[];
  runNow?: boolean;
}

function updateBadge(jobs: CronJob[]) {
  useStore.setState({ automationCount: jobs.length });
}

export function useAutomationData({
  enabled,
  isZh,
  tt,
}: {
  enabled: boolean;
  isZh: boolean;
  tt: Translate;
}) {
  const setPendingConfirm = useStore((state) => state.setPendingConfirm);
  const addToast = useStore((state) => state.addToast);
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const smokeFixture = (window as Window & {
        __lynnAutomationSmokeData?: {
          jobs: CronJob[];
          models: Array<{ id: string; name?: string; provider?: string }>;
        };
      }).__lynnAutomationSmokeData;
      if (smokeFixture) {
        const nextJobs = smokeFixture.jobs;
        setJobs(nextJobs);
        setAvailableModels(buildAutomationModelOptions(smokeFixture.models));
        updateBadge(nextJobs);
        return;
      }
      const [cronResult, modelsResult] = await Promise.allSettled([
        hanaFetch('/api/desk/cron'),
        hanaFetch('/api/models'),
      ]);
      if (cronResult.status === 'rejected') throw cronResult.reason;
      const cronData = await cronResult.value.json();
      const nextJobs = (cronData.jobs || []) as CronJob[];
      let nextModels: ModelOption[] = [];
      if (modelsResult.status === 'fulfilled') {
        try {
          const modelsData = await modelsResult.value.json();
          nextModels = buildAutomationModelOptions(modelsData.models || []);
        } catch (error) {
          console.warn('[automation] model options unavailable:', error);
        }
      } else {
        console.warn('[automation] model options unavailable:', modelsResult.reason);
      }
      setJobs(nextJobs);
      setAvailableModels(nextModels);
      updateBadge(nextJobs);
    } catch (error) {
      console.error('[automation] load failed:', error);
      setLoadError(
        isZh
          ? '自动任务面板刚才没完全加载好。点一次重试，我会重新读取任务、模板和模型。'
          : 'The automation panel did not load correctly. Retry to reload tasks, templates, and models.',
      );
    } finally {
      setLoading(false);
    }
  }, [isZh]);

  useEffect(() => {
    if (enabled) void loadData();
  }, [enabled, loadData]);

  useEffect(() => {
    if (!enabled) return undefined;
    const onActivityUpdated = (event: Event) => {
      const customEvent = event as CustomEvent<{ type?: string }>;
      if (customEvent.detail?.type === 'cron') void loadData();
    };
    window.addEventListener('hana-activity-updated', onActivityUpdated as EventListener);
    return () => window.removeEventListener('hana-activity-updated', onActivityUpdated as EventListener);
  }, [enabled, loadData]);

  const toggleJob = useCallback(async (jobId: string) => {
    try {
      await hanaFetch('/api/desk/cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'toggle', id: jobId }),
      });
      await loadData();
    } catch (error) {
      console.error('[automation] toggle failed:', error);
      addToast(error instanceof Error ? error.message : (isZh ? '自动任务状态修改失败' : 'Failed to update task status'), 'error');
    }
  }, [addToast, isZh, loadData]);

  const removeJob = useCallback((jobId: string) => {
    setPendingConfirm({
      title: tt('common.delete', '删除任务', 'Delete task'),
      message: tt('automation.deleteConfirm', '确定要删除这个定时任务吗？', 'Delete this scheduled task?'),
      confirmLabel: tt('common.delete', '删除', 'Delete'),
      cancelLabel: tt('common.cancel', '取消', 'Cancel'),
      onConfirm: async () => {
        try {
          await hanaFetch('/api/desk/cron', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'remove', id: jobId }),
          });
          await loadData();
        } catch (error) {
          console.error('[automation] remove failed:', error);
          addToast(error instanceof Error ? error.message : (isZh ? '自动任务删除失败' : 'Failed to delete task'), 'error');
          throw error;
        }
      },
    });
  }, [addToast, isZh, loadData, setPendingConfirm, tt]);

  const runJobNow = useCallback(async (jobId: string) => {
    try {
      const response = await hanaFetch('/api/desk/cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'run', id: jobId }),
      });
      const data = await response.json();
      if (!response.ok || data?.error) {
        throw new Error(data?.error || (isZh ? '没能启动这条自动任务' : 'Failed to start task'));
      }
      addToast(
        isZh
          ? '这条自动任务已经开始执行，完成后结果会出现在活动里，并写入工作区结果文件夹。'
          : 'Task started. When it finishes, the result will appear in Activity and in the workspace result folder.',
        'success',
      );
      await loadData();
    } catch (error) {
      console.error('[automation] run-now failed:', error);
      addToast(error instanceof Error ? error.message : String(error), 'error');
    }
  }, [addToast, isZh, loadData]);

  const saveJob = useCallback(async (input: SaveAutomationInput) => {
    if (!input.name || !input.prompt) return false;
    setSaving(true);
    try {
      const schedule = buildScheduleFromPreset(
        input.schedulePreset,
        input.hour,
        input.minute,
        input.weeklyDay,
        input.customDays,
      );
      const payload: Record<string, unknown> = input.editingJobId
        ? {
            action: 'update',
            id: input.editingJobId,
            label: input.name,
            prompt: input.prompt,
            schedule,
            workspace: input.project,
          }
        : {
            action: 'add',
            type: 'cron',
            label: input.name,
            prompt: input.prompt,
            schedule,
            workspace: input.project,
          };
      if (input.model) payload.model = input.model;
      const response = await hanaFetch('/api/desk/cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok || data?.error) {
        throw new Error(data?.error || tt('settings.saveFailed', '自动任务保存失败', 'Failed to save task'));
      }
      const savedJobId = String(data?.job?.id || input.editingJobId || '').trim();
      if (input.runNow && savedJobId) {
        const runResponse = await hanaFetch('/api/desk/cron', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'run', id: savedJobId }),
        });
        const runData = await runResponse.json();
        if (!runResponse.ok || runData?.error) {
          throw new Error(runData?.error || (isZh ? '创建成功，但立即测试没有启动起来' : 'Task was created, but the test run did not start'));
        }
      }
      await loadData();
      addToast(
        input.runNow
          ? (input.editingJobId
              ? tt('settings.saved', '自动任务已更新，并且已经开始测试执行', 'Task updated and test run started')
              : tt('settings.saved', '自动任务已创建，并且已经开始测试执行', 'Task created and test run started'))
          : (input.editingJobId
              ? tt('settings.saved', '自动任务已更新', 'Task updated')
              : tt('settings.saved', '自动任务已创建', 'Task created')),
        'success',
      );
      return true;
    } catch (error) {
      console.error('[automation] save failed:', error);
      addToast(error instanceof Error ? error.message : tt('settings.saveFailed', '自动任务保存失败', 'Failed to save task'), 'error');
      return false;
    } finally {
      setSaving(false);
    }
  }, [addToast, isZh, loadData, tt]);

  return {
    jobs,
    availableModels,
    loading,
    loadError,
    saving,
    loadData,
    toggleJob,
    removeJob,
    runJobNow,
    saveJob,
  };
}
