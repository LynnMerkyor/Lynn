import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSettingsStore, type ProviderSummary } from '../../store';
import { hanaFetch } from '../../api';
import { t } from '../../helpers';
import { OAuthCredentials } from './OAuthCredentials';
import { ApiKeyCredentials } from './ApiKeyCredentials';
import { ProviderModelList } from './ProviderModelList';
import { BRAIN_PROVIDER_ID, BRAIN_PROVIDER_LABEL } from '../../../../../../shared/brain-provider.js';
import styles from '../../Settings.module.css';

const platform = window.platform;
const LOCAL_QWEN35_PROVIDER_ID = 'local-qwen35-9b-q4km-imatrix';

export function ProviderDetail({ providerId, summary, providerConfig, isPresetSetup, presetInfo, onRefresh }: {
  providerId: string;
  summary: ProviderSummary;
  providerConfig?: Record<string, unknown>;
  isPresetSetup?: boolean;
  presetInfo?: { label: string; value: string; url?: string; api?: string; local?: boolean; noKey?: boolean; defaultModelId?: string };
  onRefresh: () => Promise<void>;
}) {
  const title = providerId === BRAIN_PROVIDER_ID
    ? BRAIN_PROVIDER_LABEL
    : (summary.display_name || providerId);
  return (
    <div className={styles['pv-detail-inner']}>
      <div className={styles['pv-detail-header']}>
        <h2 className={styles['pv-detail-title']}>{title}</h2>
      </div>
      {providerId === LOCAL_QWEN35_PROVIDER_ID && (
        <LocalQwen35Panel onRefresh={onRefresh} />
      )}
      {summary.supports_oauth ? (
        <OAuthCredentials providerId={providerId} summary={summary} onRefresh={onRefresh} />
      ) : (
        <ApiKeyCredentials
          providerId={providerId}
          summary={summary}
          providerConfig={providerConfig}
          isPresetSetup={isPresetSetup}
          presetInfo={presetInfo}
          onRefresh={onRefresh}
        />
      )}
      <ProviderModelList providerId={providerId} summary={summary} onRefresh={onRefresh} />
      {summary.can_delete && !isPresetSetup && providerId !== BRAIN_PROVIDER_ID && (
        <div className={styles['pv-detail-footer']}>
          <ProviderDeleteButton providerId={providerId} onRefresh={onRefresh} />
        </div>
      )}
    </div>
  );
}

type LocalQwen35Status = {
  ok?: boolean;
  job?: {
    status?: string;
    log_file?: string;
    result?: unknown;
    stderr_tail?: string;
  } | null;
  plan?: {
    decision?: string;
    base_url?: string;
    hardware?: {
      can_enable?: boolean;
      recommendation?: string;
      chip?: string | null;
      total_memory_gib?: number | null;
      gpus?: Array<{ name?: string; memory_gib?: number | null; compute_capability?: number | null }>;
      recommended_runtime?: {
        label?: string;
        ctx_size?: number;
        parallel?: number;
        gpu_layers?: number;
      };
      warnings?: string[];
      blockers?: string[];
    };
    observed?: {
      endpoint_running?: boolean;
      gguf?: string | null;
      llama_server?: string | null;
      homebrew_available?: boolean;
    };
    actions?: Array<{ id?: string; label?: string }>;
  };
  error?: string;
};

function LocalQwen35Panel({ onRefresh }: { onRefresh: () => Promise<void> }) {
  const { showToast } = useSettingsStore();
  const [status, setStatus] = useState<LocalQwen35Status | null>(null);
  const [loading, setLoading] = useState(false);
  const [settingUp, setSettingUp] = useState(false);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await hanaFetch('/api/local-qwen35-9b/status', { timeout: 20_000 });
      const data = await res.json();
      setStatus(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus({ ok: false, error: msg });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const plan = status?.plan || {};
  const observed = plan.observed || {};
  const hardware = plan.hardware || {};
  const runtime = hardware.recommended_runtime || {};
  const hardwareWarnings = [...(hardware.warnings || []), ...(hardware.blockers || [])];
  const gpu = hardware.gpus?.[0];
  const endpointRunning = observed.endpoint_running === true;
  const hasModel = !!observed.gguf;
  const hasRuntime = !!observed.llama_server;
  const jobRunning = status?.job?.status === 'running';
  const hardwareBlocked = hardware.can_enable === false;
  const stateLabel = useMemo(() => {
    if (jobRunning) return '正在准备';
    if (endpointRunning) return '已运行';
    if (hasModel && hasRuntime) return '可启动';
    return '待安装';
  }, [endpointRunning, hasModel, hasRuntime, jobRunning]);

  const authorizeAndSetup = async () => {
    const profile = runtime.label ? `\n\n推荐配置：${runtime.label}，上下文 ${runtime.ctx_size || 8192}，并发 ${runtime.parallel || 1}` : '';
    const warning = hardwareWarnings.length ? `\n\n注意：${hardwareWarnings.join(' ')}` : '';
    const ok = window.confirm(`Lynn 将在本机安装或定位 llama.cpp，下载 Qwen3.5-9B Q4_K_M imatrix，并启动本地模型服务。${profile}${warning}\n\n继续吗？`);
    if (!ok) return;
    setSettingUp(true);
    try {
      const res = await hanaFetch('/api/local-qwen35-9b/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authorized: true, variant: 'imatrix', start: true }),
        timeout: 30_000,
      });
      const data = await res.json();
      setStatus((prev) => ({ ...(prev || {}), job: data.job }));
      showToast('本地 9B 正在后台准备，完成后会自动注册为可用模型。', 'info');
      await onRefresh();
      window.setTimeout(loadStatus, 1500);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast('本地 9B 启用失败：' + msg, 'error');
    } finally {
      setSettingUp(false);
    }
  };

  const registerOnly = async () => {
    try {
      await hanaFetch('/api/local-qwen35-9b/register', { method: 'POST', timeout: 10_000 });
      showToast('本地 9B 已注册到模型列表。', 'success');
      await onRefresh();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast('注册失败：' + msg, 'error');
    }
  };

  return (
    <section className={styles['pv-local-qwen-panel']}>
      <div className={styles['pv-local-qwen-main']}>
        <div>
          <div className={styles['pv-local-qwen-kicker']}>本地 9B，日常无限用</div>
          <div className={styles['pv-local-qwen-title']}>Qwen3.5-9B Q4_K_M imatrix</div>
          <div className={styles['pv-local-qwen-desc']}>
            Lynn 会在用户授权后自动准备 llama.cpp、模型文件和本地 OpenAI 端点，MIMO 保持兜底。
          </div>
        </div>
        <span className={`${styles['pv-local-qwen-state']} ${endpointRunning ? styles['ready'] : ''}`}>
          {loading ? '检查中' : stateLabel}
        </span>
      </div>

      <div className={styles['pv-local-qwen-facts']}>
        <span>模型 {hasModel ? '已就绪' : '待下载'}</span>
        <span>llama.cpp {hasRuntime ? '已找到' : '待安装'}</span>
        <span>{plan.base_url || 'http://127.0.0.1:18099/v1'}</span>
      </div>

      <div className={styles['pv-local-qwen-hardware']}>
        <div className={styles['pv-local-qwen-hardware-title']}>硬件判断</div>
        <div className={styles['pv-local-qwen-facts']}>
          <span>{runtime.label || '云端兜底优先'}</span>
          {hardware.chip && <span>{hardware.chip}</span>}
          {gpu?.name && <span>{gpu.name}{gpu.memory_gib ? ` · ${gpu.memory_gib.toFixed(1)}GB` : ''}</span>}
          {hardware.total_memory_gib && <span>内存 {hardware.total_memory_gib.toFixed(1)}GB</span>}
          {runtime.ctx_size && <span>上下文 {runtime.ctx_size}</span>}
          {runtime.parallel && <span>并发 {runtime.parallel}</span>}
        </div>
        {hardwareWarnings.length > 0 && (
          <div className={styles['pv-local-qwen-warning']}>{hardwareWarnings.join(' ')}</div>
        )}
      </div>

      {status?.error && (
        <div className={styles['pv-local-qwen-error']}>{status.error}</div>
      )}
      {status?.job?.status && (
        <div className={styles['pv-local-qwen-job']}>
          后台任务：{status.job.status}{status.job.log_file ? ` · ${status.job.log_file}` : ''}
        </div>
      )}

      <div className={styles['pv-local-qwen-actions']}>
        <button
          className={`${styles['pv-setup-activate-btn']} ${styles['pv-local-qwen-primary']}`}
          onClick={authorizeAndSetup}
          disabled={settingUp || jobRunning || hardwareBlocked}
        >
          {hardwareBlocked ? '硬件不建议本地启用' : endpointRunning ? '重新检查并启用' : '授权安装并启用'}
        </button>
        <button className={styles['pv-verify-connection-btn']} onClick={loadStatus} disabled={loading}>
          刷新状态
        </button>
        <button className={styles['pv-verify-connection-btn']} onClick={registerOnly}>
          仅注册 provider
        </button>
      </div>
    </section>
  );
}

function ProviderDeleteButton({ providerId, onRefresh }: { providerId: string; onRefresh: () => Promise<void> }) {
  const { showToast } = useSettingsStore();
  const [confirming, setConfirming] = useState(false);

  const handleDelete = async () => {
    try {
      const res = await hanaFetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers: { [providerId]: null } }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      showToast(t('settings.providers.deleted', { name: providerId }), 'success');
      useSettingsStore.setState({ selectedProviderId: null });
      setConfirming(false);
      await onRefresh();
      platform?.settingsChanged?.('models-changed');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(t('settings.saveFailed') + ': ' + msg, 'error');
    }
  };

  return (
    <>
      <button className={styles['pv-delete-btn']} onClick={() => setConfirming(true)}>
        {t('settings.providers.delete')}
      </button>
      {confirming && (
        <>
          <div className={styles['pv-model-edit-overlay']} onClick={() => setConfirming(false)} />
          <div className={styles['pv-confirm-dialog']}>
            <p className={styles['pv-confirm-text']}>
              {t('settings.providers.deleteConfirm', { name: providerId })}
            </p>
            <div className={styles['pv-confirm-actions']}>
              <button className={styles['pv-add-form-btn']} onClick={() => setConfirming(false)}>{t('settings.api.cancel')}</button>
              <button className={`${styles['pv-add-form-btn']} ${styles['danger']}`} onClick={handleDelete}>{t('settings.providers.delete')}</button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
