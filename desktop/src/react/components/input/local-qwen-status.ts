export const LOCAL_QWEN35_PROVIDER_ID = 'local-qwen35-9b-q4km-imatrix';
export const LOCAL_QWEN35_MODEL_ID = 'qwen35-9b-q4km-imatrix';
export const LOCAL_QWEN35_ENDPOINT = 'http://127.0.0.1:18099/v1';
export const LOCAL_QWEN_PROMPT_DISMISS_KEY = 'lynn-local-model-prompt-dismissed-date';
export const LOCAL_QWEN_PROMPT_SHOWN_KEY = 'lynn-local-model-prompt-shown-date';
export const LOCAL_QWEN_PROMPT_DELAY_MS = 8_000;

export type LocalQwen35RuntimeStatus = {
  ok?: boolean;
  registered_provider?: boolean;
  runtime?: {
    base_url?: string;
    gui_url?: string;
    pid?: number | null;
    endpoint_running?: boolean;
    endpoint_running_any?: boolean;
    endpoint_loading?: boolean;
    endpoint_occupied?: boolean;
    serves_default_model?: boolean;
    process_alive?: boolean;
    health_status?: number;
    model_ids?: string[];
    foreign_model_ids?: string[];
    slots?: {
      total?: number;
      busy?: number;
    } | null;
    metrics?: {
      prompt_tokens_total?: number | null;
      predicted_tokens_total?: number | null;
      requests_total?: number | null;
      predicted_tps?: number | null;
      tps_window_seconds?: number | null;
    } | null;
    metrics_available?: boolean;
  };
  plan?: {
    base_url?: string;
    observed?: {
      endpoint_running?: boolean;
      endpoint_loading?: boolean;
      endpoint_occupied?: boolean;
      served_model_ids?: string[];
      gguf?: string | null;
      llama_server?: string | null;
    };
    plan?: {
      base_url?: string;
      observed?: {
        endpoint_running?: boolean;
        endpoint_loading?: boolean;
        endpoint_occupied?: boolean;
        served_model_ids?: string[];
        gguf?: string | null;
        llama_server?: string | null;
      };
      hardware?: {
        can_enable?: boolean;
        recommended_runtime?: {
          label?: string;
        };
      };
    };
    hardware?: {
      can_enable?: boolean;
      recommended_runtime?: {
        label?: string;
      };
    };
  };
};

export type LocalQwenWarmupStage = 'ready' | 'launching' | 'loading' | 'checking';

export function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

export function deriveLocalQwenRuntimeState(
  status: LocalQwen35RuntimeStatus | null,
  optimisticStarting: boolean,
  currentModelInfo?: { id?: string | null; provider?: string | null } | null,
) {
  const servedModelIds = status?.runtime?.model_ids
    || status?.plan?.observed?.served_model_ids
    || status?.plan?.plan?.observed?.served_model_ids
    || [];
  const defaultServed = status?.runtime?.serves_default_model === true
    || servedModelIds.includes(LOCAL_QWEN35_MODEL_ID);
  const endpointOccupied = status?.runtime?.endpoint_occupied === true
    || status?.plan?.observed?.endpoint_occupied === true
    || status?.plan?.plan?.observed?.endpoint_occupied === true
    || ((status?.runtime?.endpoint_running_any === true || status?.runtime?.endpoint_running === true)
      && servedModelIds.length > 0
      && !defaultServed);
  const running = defaultServed && (
    status?.runtime?.endpoint_running === true
    || status?.plan?.observed?.endpoint_running === true
    || status?.plan?.plan?.observed?.endpoint_running === true
  );
  const runtimeLoading = !endpointOccupied && (
    status?.runtime?.endpoint_loading === true
    || status?.runtime?.process_alive === true
    || status?.plan?.observed?.endpoint_loading === true
    || status?.plan?.plan?.observed?.endpoint_loading === true
  );
  const loading = !running && (optimisticStarting || runtimeLoading);
  const starting = !running && optimisticStarting && !runtimeLoading;
  const active = running || loading || endpointOccupied;
  const current = currentModelInfo?.id === LOCAL_QWEN35_MODEL_ID
    && currentModelInfo?.provider === LOCAL_QWEN35_PROVIDER_ID;
  const endpoint = status?.runtime?.base_url
    || status?.plan?.base_url
    || status?.plan?.plan?.base_url
    || LOCAL_QWEN35_ENDPOINT;
  const runtimeLabel = status?.plan?.hardware?.recommended_runtime?.label
    || status?.plan?.plan?.hardware?.recommended_runtime?.label
    || '本机 32K';
  const canEnable = (status?.plan?.hardware?.can_enable
    ?? status?.plan?.plan?.hardware?.can_enable) !== false;
  const hasModel = !!(status?.plan?.observed?.gguf || status?.plan?.plan?.observed?.gguf);
  const hasRuntime = !endpointOccupied
    && !!(status?.plan?.observed?.llama_server || status?.plan?.plan?.observed?.llama_server);
  const metricTokens = Math.round(
    Number(status?.runtime?.metrics?.predicted_tokens_total || 0)
      + Number(status?.runtime?.metrics?.prompt_tokens_total || 0),
  );
  const metricsReady = status?.runtime?.metrics_available === true;
  const predictedTpsValue = status?.runtime?.metrics?.predicted_tps;
  const predictedTps = typeof predictedTpsValue === 'number'
    && Number.isFinite(predictedTpsValue)
    ? predictedTpsValue
    : null;
  const tpsSummary = predictedTps !== null
    ? `当前 ${predictedTps.toFixed(predictedTps >= 10 ? 0 : 1)} tok/s`
    : null;
  const slots = status?.runtime?.slots;
  const slotSummary = slots?.total
    ? ((slots.busy || 0) > 0
      ? `生成中 ${slots.busy || 0}/${slots.total}`
      : `可用 ${Math.max(0, slots.total - (slots.busy || 0))}/${slots.total}`)
    : null;
  const busySlots = Number(slots?.busy || 0);
  const metricSummary = metricsReady
    ? (metricTokens > 0 ? `服务累计处理 ${metricTokens.toLocaleString()} tokens` : '服务暂无 token 统计')
    : '运行统计同步中';
  const coldStartLikely = running && current && busySlots > 0 && metricTokens < 800;
  const warmupStage: LocalQwenWarmupStage = running
    ? 'ready'
    : starting
      ? 'launching'
      : loading
        ? 'loading'
        : 'checking';
  return {
    servedModelIds,
    defaultServed,
    endpointOccupied,
    running,
    runtimeLoading,
    loading,
    starting,
    active,
    current,
    endpoint,
    runtimeLabel,
    canEnable,
    hasModel,
    hasRuntime,
    metricTokens,
    metricsReady,
    predictedTps,
    tpsSummary,
    slotSummary,
    busySlots,
    metricSummary,
    coldStartLikely,
    warmupStage,
  };
}
