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
const LOCAL_QWEN35_PROVIDER_LABEL = '本地 Qwen3.5-9B';

type LocalActionStatus = {
  kind: 'info' | 'success' | 'error';
  text: string;
};

function localEndpointRoot(baseUrl?: string | null) {
  return String(baseUrl || 'http://127.0.0.1:18099/v1').replace(/\/v1\/?$/, '');
}

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
    : providerId === LOCAL_QWEN35_PROVIDER_ID
      ? LOCAL_QWEN35_PROVIDER_LABEL
    : (summary.display_name || providerId);
  return (
    <div className={styles['pv-detail-inner']}>
      <div className={styles['pv-detail-header']}>
        <h2 className={styles['pv-detail-title']}>{title}</h2>
      </div>
      {providerId === LOCAL_QWEN35_PROVIDER_ID && (
        <LocalQwen35Panel onRefresh={onRefresh} />
      )}
      {providerId === LOCAL_QWEN35_PROVIDER_ID ? null : (
        <>
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
        </>
      )}
    </div>
  );
}

type LocalQwen35Status = {
  ok?: boolean;
  registered_provider?: boolean;
  runtime?: {
    gui_url?: string;
    pid?: number | null;
    endpoint_running?: boolean;
    endpoint_loading?: boolean;
    process_alive?: boolean;
    health_status?: number;
    metrics?: {
      prompt_tokens_total?: number | null;
      predicted_tokens_total?: number | null;
      requests_total?: number | null;
    } | null;
    metrics_available?: boolean;
    slots?: {
      total?: number;
      busy?: number;
    } | null;
  };
  job?: {
    status?: string;
    log_file?: string;
    result?: unknown;
    stderr_tail?: string;
    progress?: {
      phase?: string;
      source?: string | null;
      percent?: number | null;
      downloaded?: string;
      total?: string;
      elapsed?: string;
      eta?: string;
      speed?: string;
      message?: string;
      tail?: string[];
    } | null;
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
      upgrade_options?: Array<{
        id?: string;
        label?: string;
        profile?: string;
        metrics?: string[];
        reason?: string;
        modelscope_url?: string;
        download_label?: string;
      }>;
      warnings?: string[];
      blockers?: string[];
    };
    observed?: {
      endpoint_running?: boolean;
      endpoint_loading?: boolean;
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
  const [registering, setRegistering] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [customStarting, setCustomStarting] = useState(false);
  const [showAdvancedLauncher, setShowAdvancedLauncher] = useState(false);
  const [actionStatus, setActionStatus] = useState<LocalActionStatus | null>(null);

  const loadStatus = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    if (!quiet) setActionStatus({ kind: 'info', text: '正在刷新本地模型状态…' });
    try {
      const res = await hanaFetch('/api/local-qwen35-9b/status', { timeout: 60_000 });
      const data = await res.json();
      setStatus(data);
      if (!quiet) {
        const running = data?.plan?.observed?.endpoint_running === true || data?.runtime?.endpoint_running === true;
        const loadingNow = data?.plan?.observed?.endpoint_loading === true || data?.runtime?.endpoint_loading === true;
        setActionStatus({
          kind: running ? 'success' : 'info',
          text: running
            ? `本地端点正在运行：${data?.plan?.base_url || 'http://127.0.0.1:18099/v1'}`
            : loadingNow
              ? '模型正在加载权重，Lynn 会继续刷新状态。'
              : '状态已刷新。本地模型未运行时，可点击启动或重新注册端点。',
        });
      }
      if (data?.registered_provider && data?.plan?.observed?.endpoint_running) {
        platform?.settingsChanged?.('models-changed');
        window.dispatchEvent(new CustomEvent('models-changed'));
        void onRefresh();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus((prev) => ({
        ...(prev || { ok: false }),
        error: msg.includes('aborted') ? '状态刷新超时，保留上一帧状态并继续后台检查。' : msg,
      }));
      if (!quiet) setActionStatus({ kind: 'error', text: `状态刷新失败：${msg}` });
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [onRefresh]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const plan = status?.plan || {};
  const observed = plan.observed || {};
  const hardware = plan.hardware || {};
  const runtime = hardware.recommended_runtime || {};
  const hardwareWarnings = [...(hardware.warnings || []), ...(hardware.blockers || [])];
  const gpu = hardware.gpus?.[0];
  const endpointRunning = observed.endpoint_running === true || status?.runtime?.endpoint_running === true;
  const endpointLoading = !endpointRunning && (
    observed.endpoint_loading === true
      || status?.runtime?.endpoint_loading === true
      || status?.runtime?.process_alive === true
  );
  const endpointActive = endpointRunning || endpointLoading;
  const hasModel = !!observed.gguf;
  const hasRuntime = !!observed.llama_server;
  const jobRawStatus = status?.job?.status;
  const jobRunning = jobRawStatus === 'running';
  const jobStatusLabel = useMemo(() => {
    if (!jobRawStatus) return null;
    if (endpointRunning && jobRawStatus === 'failed') return '端点已运行';
    if (jobRawStatus === 'succeeded') return '已完成';
    if (jobRawStatus === 'running') return '正在准备';
    if (jobRawStatus === 'failed') return '需要处理';
    return jobRawStatus;
  }, [endpointRunning, jobRawStatus]);
  const showJobStatus = !!jobStatusLabel
    && jobRawStatus !== 'succeeded'
    && !(endpointRunning && jobRawStatus === 'failed');
  const progress = status?.job?.progress || null;
  const upgradeOptions = hardware.upgrade_options || [];
  const progressPercent = typeof progress?.percent === 'number'
    ? Math.max(0, Math.min(100, progress.percent))
    : null;
  const runtimeStats = status?.runtime;
  const runtimeTokens = Math.round(
    Number(runtimeStats?.metrics?.prompt_tokens_total || 0)
      + Number(runtimeStats?.metrics?.predicted_tokens_total || 0),
  );
  const runtimeMetricsReady = runtimeStats?.metrics_available === true;
  const slotLabel = (() => {
    const slots = runtimeStats?.slots;
    if (!slots?.total) return null;
    const busy = slots.busy || 0;
    const idle = Math.max(0, slots.total - busy);
    return busy > 0 ? `处理中 ${busy}/${slots.total}` : `空闲 ${idle}/${slots.total}`;
  })();
  const hardwareBlocked = hardware.can_enable === false;
  const stateLabel = useMemo(() => {
    if (jobRunning) return '正在准备';
    if (endpointLoading) return '正在加载';
    if (endpointRunning) return '已运行';
    if (hasModel && hasRuntime) return '可启动';
    return '待安装';
  }, [endpointLoading, endpointRunning, hasModel, hasRuntime, jobRunning]);

  useEffect(() => {
    if (!jobRunning) return undefined;
    const id = window.setInterval(() => {
      loadStatus(true);
    }, 2000);
    return () => window.clearInterval(id);
  }, [jobRunning, loadStatus]);

  const authorizeAndSetup = async () => {
    const profile = runtime.label ? `\n\n推荐配置：${runtime.label}，上下文 ${runtime.ctx_size || 8192}，并发 ${runtime.parallel || 1}` : '';
    const warning = hardwareWarnings.length ? `\n\n注意：${hardwareWarnings.join(' ')}` : '';
    const setupText = hasModel && hasRuntime
      ? 'Lynn 将启动本地 Qwen3.5-9B 模型服务，并切换为本地模型。'
      : 'Lynn 将在本机安装或定位 llama.cpp，下载 Qwen3.5-9B Q4_K_M imatrix，并启动本地模型服务。\n\n模型约 5.3GB，支持 32K 上下文。完成后可离线使用，不需要 API Key，不上传对话。';
    const ok = window.confirm(`${setupText}${profile}${warning}\n\n继续吗？`);
    if (!ok) return;
    setSettingUp(true);
    setActionStatus({ kind: 'info', text: hasModel && hasRuntime ? '正在启动本地模型服务…' : '已获得授权，正在后台准备 llama.cpp 和模型文件…' });
    try {
      const res = await hanaFetch('/api/local-qwen35-9b/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authorized: true, variant: 'imatrix', start: true }),
        timeout: 30_000,
      });
      const data = await res.json();
      setStatus((prev) => ({ ...(prev || {}), job: data.job }));
      showToast(
        hasModel && hasRuntime
          ? '本地 9B 正在启动，加载完成后会自动切换为当前模型。'
          : '本地 9B 正在后台准备，完成后会自动注册并切换为当前模型。',
        'info',
      );
      setActionStatus({
        kind: 'info',
        text: hasModel && hasRuntime
          ? '启动任务已提交。加载完成后会自动切换为本地模型。'
          : '安装/下载任务已提交。进度会在此处持续刷新。',
      });
      await onRefresh();
      window.setTimeout(loadStatus, 1500);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast('本地 9B 启用失败：' + msg, 'error');
      setActionStatus({ kind: 'error', text: `启用失败：${msg}` });
    } finally {
      setSettingUp(false);
    }
  };

  const snoozeLocalModel = () => {
    const tomorrow = Date.now() + 24 * 60 * 60 * 1000;
    try {
      window.localStorage.setItem('lynn-local-model-snooze-until', String(tomorrow));
    } catch {
      // localStorage may be unavailable in hardened contexts.
    }
    showToast('已暂不启用。本地模型推荐会降频，明天再轻提醒。', 'info');
  };

  const registerOnly = async () => {
    setRegistering(true);
    setActionStatus({ kind: 'info', text: '正在重新注册本地 OpenAI 端点，并刷新模型列表…' });
    try {
      await hanaFetch('/api/local-qwen35-9b/register', { method: 'POST', timeout: 10_000 });
      showToast('本地 9B 已注册到模型列表。', 'success');
      setActionStatus({ kind: 'success', text: '已重新注册本地端点，并切换到本地 Qwen3.5-9B。' });
      platform?.settingsChanged?.('models-changed');
      window.dispatchEvent(new CustomEvent('models-changed'));
      await onRefresh();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast('注册失败：' + msg, 'error');
      setActionStatus({ kind: 'error', text: `重新注册失败：${msg}` });
    } finally {
      setRegistering(false);
    }
  };

  const stopLocalModel = async () => {
    setStopping(true);
    setActionStatus({ kind: 'info', text: '正在停止本地模型服务…' });
    try {
      const res = await hanaFetch('/api/local-qwen35-9b/stop', { method: 'POST', timeout: 10_000 });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) throw new Error(data?.error || 'stop_failed');
      showToast('本地 9B 已停止。', 'success');
      setActionStatus({ kind: 'success', text: '本地模型已停止。需要时可再次启动。' });
      await loadStatus(false);
      await onRefresh();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast('停止失败：' + msg, 'error');
      setActionStatus({ kind: 'error', text: `停止失败：${msg}` });
    } finally {
      setStopping(false);
    }
  };

  const openLocalDashboard = () => {
    const root = localEndpointRoot(plan.base_url);
    const target = endpointRunning ? root : `${root}/v1/models`;
    platform?.openExternal?.(target);
    setActionStatus({ kind: 'info', text: `已打开 llama.cpp 端点：${target}` });
    showToast(`已打开本地端点：${target}`, 'info');
  };

  const openModelFolder = async () => {
    const res = await platform?.llamacppOpenModelDir?.();
    const modelPath = typeof observed.gguf === 'string' ? observed.gguf : '';
    setActionStatus({
      kind: res?.ok ? 'success' : 'info',
      text: res?.ok
        ? `已打开本地模型库：${res.path || '~/.lynn/models'}${modelPath ? '。当前 9B GGUF 已在本机就绪。' : ''}`
        : '当前还没有已绑定的模型文件。请把 9B/27B/35B GGUF 放入本地模型目录，或点击“选择 GGUF”直接启动。',
    });
  };

  const chooseGgufModel = async () => {
    if (!platform?.selectGgufModel || !platform?.llamacppStartCustomModel) {
      setActionStatus({ kind: 'error', text: '当前运行环境不支持原生 GGUF 选择器。请使用桌面客户端。' });
      return;
    }
    setCustomStarting(true);
    try {
      const modelPath = await platform.selectGgufModel();
      if (!modelPath) {
        setActionStatus({ kind: 'info', text: '未选择模型。默认 9B 仍保持可用。' });
        return;
      }
      const fileName = modelPath.split(/[\\/]/).pop() || 'GGUF 模型';
      setActionStatus({ kind: 'info', text: `已选择 ${fileName}，正在用 llama.cpp 启动…` });
      const res = await platform.llamacppStartCustomModel(modelPath);
      if (!res?.ok) {
        throw new Error(res?.reason || 'start-custom-model-failed');
      }
      showToast(`正在启动 ${fileName}，状态会在此处和聊天栏同步。`, 'success');
      setActionStatus({ kind: 'success', text: `已提交启动：${fileName}。加载完成后可直接在聊天中使用本地端点。` });
      window.setTimeout(loadStatus, 1600);
      await onRefresh();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast('自选模型启动失败：' + msg, 'error');
      setActionStatus({ kind: 'error', text: `自选模型启动失败：${msg}` });
    } finally {
      setCustomStarting(false);
    }
  };

  return (
    <section className={styles['pv-local-qwen-panel']}>
      <div className={styles['pv-local-qwen-main']}>
        <div>
          <div className={styles['pv-local-qwen-kicker']}>本地 9B，日常无限用</div>
          <div className={styles['pv-local-qwen-title']}>Qwen3.5-9B Q4_K_M imatrix</div>
          <div className={styles['pv-local-qwen-desc']}>
            5.3GB · 32K 上下文 · MMLU 90+ / GPQA 80+ · JSON 输出与工具调用稳定。Lynn 会在用户授权后自动准备
            llama.cpp、模型文件和本地 OpenAI 端点；完成后可离线使用，不需要 API Key，不上传对话。
          </div>
        </div>
        <span className={`${styles['pv-local-qwen-state']} ${endpointActive ? styles['ready'] : ''}`}>
          {loading && !endpointActive ? '检查中' : stateLabel}
        </span>
      </div>

      <div className={styles['pv-local-qwen-benefits']}>
        <span>MMLU 90+</span>
        <span>GPQA 80+</span>
        <span>5.3GB</span>
        <span>32K 上下文</span>
        <span>JSON 输出稳定</span>
        <span>工具调用稳定</span>
        <span>本地优先</span>
        <span>无限 token</span>
        <span>隐私留在本机</span>
      </div>

      <div className={styles['pv-local-qwen-facts']}>
        <span>模型 {hasModel ? '已就绪' : '待下载'}</span>
        <span>llama.cpp {hasRuntime ? '已找到' : '待安装'}</span>
        {endpointActive && runtimeStats?.pid && <span>PID {runtimeStats.pid}</span>}
        {endpointLoading && <span>模型权重加载中</span>}
        {endpointRunning && <span>{runtimeMetricsReady ? `${runtimeTokens.toLocaleString()} tokens` : '统计同步中'}</span>}
        {endpointRunning && slotLabel && <span>{slotLabel}</span>}
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

      {upgradeOptions.length > 0 && (
        <div className={styles['pv-local-qwen-upgrade']}>
          <div className={styles['pv-local-qwen-hardware-title']}>更多本地模型</div>
          {upgradeOptions.map((option) => (
            <div key={option.id || option.label} className={styles['pv-local-qwen-upgrade-card']}>
              <div className={styles['pv-local-qwen-upgrade-copy']}>
                <strong>{option.label || 'Qwen3.6-35B-A3B Q4_K_M imatrix'}</strong>
                {option.profile && <em>{option.profile}</em>}
                {Array.isArray(option.metrics) && option.metrics.length > 0 && (
                  <div className={styles['pv-local-qwen-upgrade-metrics']}>
                    {option.metrics.map((metric) => (
                      <span key={metric}>{metric}</span>
                    ))}
                  </div>
                )}
                <span>{option.reason || '32GB+ 设备可试高能力本地模型。'}</span>
              </div>
              <div className={styles['pv-local-qwen-upgrade-actions']}>
                {option.modelscope_url ? (
                  <a href={option.modelscope_url} target="_blank" rel="noreferrer">{option.download_label || '下载/查看'}</a>
                ) : (
                  <span className={styles['pv-local-qwen-upgrade-pending']}>发布中</span>
                )}
                <button
                  type="button"
                  className={styles['pv-local-qwen-upgrade-action-btn']}
                  onClick={chooseGgufModel}
                  disabled={customStarting}
                >
                  {customStarting ? '启动中' : '选择本机 GGUF'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className={styles['pv-local-qwen-advanced']}>
        <button
          type="button"
          className={styles['pv-local-qwen-advanced-toggle']}
          onClick={() => setShowAdvancedLauncher((value) => !value)}
          aria-expanded={showAdvancedLauncher}
        >
          {showAdvancedLauncher ? '收起本地模型库' : '本地模型库'}
        </button>
        {showAdvancedLauncher && (
          <div className={styles['pv-local-qwen-advanced-panel']}>
            <div>
              <strong>自选 GGUF 模型</strong>
              <span>默认使用 9B。你也可以选本机已有的 27B/35B GGUF，Lynn 会按当前硬件配置启动 llama.cpp，并同步本地端点状态。</span>
            </div>
            <div className={styles['pv-local-qwen-advanced-actions']}>
              <button type="button" className={styles['pv-verify-connection-btn']} onClick={openModelFolder}>
                打开模型目录
              </button>
              <button
                type="button"
                className={styles['pv-verify-connection-btn']}
                onClick={chooseGgufModel}
                disabled={customStarting}
              >
                {customStarting ? '启动中' : '选择 GGUF'}
              </button>
            </div>
          </div>
        )}
      </div>

      {status?.error && (
        <div className={styles['pv-local-qwen-error']}>{status.error}</div>
      )}
      {actionStatus && (
        <div className={`${styles['pv-local-qwen-action-status']} ${styles[`pv-local-qwen-action-status-${actionStatus.kind}`]}`}>
          {actionStatus.text}
        </div>
      )}
      {showJobStatus && (
        <div className={styles['pv-local-qwen-job']}>
          后台任务：{jobStatusLabel}{status?.job?.log_file ? ' · 日志已保存' : ''}
        </div>
      )}
      {jobRunning && progress && (
        <div className={styles['pv-local-qwen-progress']}>
          <div className={styles['pv-local-qwen-progress-row']}>
            <span>{progress.phase || '准备本地模型'}</span>
            {progressPercent !== null && <strong>{progressPercent.toFixed(0)}%</strong>}
          </div>
          {progressPercent !== null && (
            <div className={styles['pv-local-qwen-progress-track']} aria-label="本地模型准备进度">
              <div
                className={styles['pv-local-qwen-progress-bar']}
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          )}
          {(progress.downloaded || progress.total || progress.speed || progress.eta) && (
            <div className={styles['pv-local-qwen-progress-meta']}>
              {progress.downloaded && progress.total && <span>{progress.downloaded} / {progress.total}</span>}
              {progress.speed && <span>{progress.speed}</span>}
              {progress.eta && <span>剩余 {progress.eta}</span>}
            </div>
          )}
          {progress.tail && progress.tail.length > 0 && (
            <div className={styles['pv-local-qwen-progress-tail']}>
              {progress.tail.slice(-3).map((line, idx) => (
                <div key={`${idx}-${line}`}>{line}</div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className={styles['pv-local-qwen-actions']}>
        <button
          className={`${styles['pv-setup-activate-btn']} ${styles['pv-local-qwen-primary']}`}
          onClick={endpointActive ? () => loadStatus(false) : authorizeAndSetup}
          disabled={settingUp || jobRunning || hardwareBlocked || endpointLoading}
        >
          {hardwareBlocked
            ? '硬件不建议本地启用'
            : endpointLoading
              ? '模型加载中'
              : endpointRunning
                ? '已启用，重新检查'
                : hasModel && hasRuntime
                  ? '启动本地模型'
                  : '授权安装并启用'}
        </button>
        <button className={styles['pv-verify-connection-btn']} onClick={() => loadStatus(false)} disabled={loading}>
          {loading ? '刷新中' : '刷新状态'}
        </button>
        {endpointActive && (
          <>
            {endpointRunning && <button className={styles['pv-verify-connection-btn']} onClick={openLocalDashboard}>
              查看端点
            </button>}
            <button className={styles['pv-verify-connection-btn']} onClick={stopLocalModel} disabled={stopping}>
              {stopping ? '停止中' : '停止本地模型'}
            </button>
          </>
        )}
        <button className={styles['pv-verify-connection-btn']} onClick={registerOnly} disabled={registering}>
          {registering ? '注册中' : '重新注册本地端点'}
        </button>
        <button className={styles['pv-verify-connection-btn']} onClick={snoozeLocalModel}>
          暂不启用
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
