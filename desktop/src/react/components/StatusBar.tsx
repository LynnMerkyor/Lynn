import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../stores';
import { connectWebSocket } from '../services/websocket';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { isDisplayDefaultModel } from '../utils/brain-models';
import { getBrainComplianceNote } from '../../../../shared/brain-provider.js';
import { getUserFacingModelAlias } from '../../../../shared/assistant-role-models.js';
import styles from './StatusBar.module.css';

declare function t(key: string, vars?: Record<string, string | number>): string;

const LOCAL_QWEN_PROVIDER_ID = 'local-qwen35-4b-q4km';
const LOCAL_QWEN_MODEL_ID = 'qwen35-4b-q4km';

type LocalQwenStatus = {
  runtime?: {
    endpoint_running?: boolean;
    endpoint_loading?: boolean;
    process_alive?: boolean;
    metrics?: {
      prompt_tokens_total?: number | null;
      predicted_tokens_total?: number | null;
    } | null;
  } | null;
  plan?: {
    observed?: {
      endpoint_running?: boolean;
      endpoint_loading?: boolean;
    } | null;
  } | null;
};

function isLocalQwenModel(model: { id: string; provider: string } | null): boolean {
  return model?.provider === LOCAL_QWEN_PROVIDER_ID && model.id === LOCAL_QWEN_MODEL_ID;
}

function formatLocalQwenTag(status: LocalQwenStatus | null): string {
  const endpointRunning = status?.runtime?.endpoint_running === true
    || status?.plan?.observed?.endpoint_running === true;
  const endpointLoading = !endpointRunning && (
    status?.runtime?.endpoint_loading === true
      || status?.runtime?.process_alive === true
      || status?.plan?.observed?.endpoint_loading === true
  );
  if (endpointRunning) {
    const promptTokens = Number(status?.runtime?.metrics?.prompt_tokens_total || 0);
    const predictedTokens = Number(status?.runtime?.metrics?.predicted_tokens_total || 0);
    const totalTokens = Math.round(promptTokens + predictedTokens);
    return totalTokens > 0
      ? `本地 Qwen3.5-4B 正在运行 · ${totalTokens.toLocaleString()} tokens`
      : '本地 Qwen3.5-4B 正在运行';
  }
  if (endpointLoading) return '本地 Qwen3.5-4B 正在加载';
  return '本地 Qwen3.5-4B 已选择 · 模型未启动';
}

function formatModelTag(
  kind: string,
  model: { id: string; provider: string } | null,
  role?: string | null,
  purpose?: 'chat' | 'utility' | 'utility_large',
  localQwenStatus?: LocalQwenStatus | null,
): string | null {
  if (!model?.id) return null;
  if (isLocalQwenModel(model)) {
    return formatLocalQwenTag(localQwenStatus || null);
  }
  const alias = getUserFacingModelAlias({
    modelId: model.id,
    provider: model.provider,
    role,
    purpose,
  });
  if (alias) {
    return `${kind} ${alias} · 已就绪`;
  }
  if (isDisplayDefaultModel(model.id, model.provider)) {
    return `${kind} 默认模型 · 已备案`;
  }
  const ref = model.provider ? `${model.provider}/${model.id}` : model.id;
  return `${kind} ${ref}`;
}

export function StatusBar() {
  const wsState = useStore((s) => s.wsState);
  const attempt = useStore((s) => s.wsReconnectAttempt);
  const currentModel = useStore((s) => s.currentModel);
  const utilityModel = useStore((s) => s.utilityModel);
  const utilityLargeModel = useStore((s) => s.utilityLargeModel);
  const agentYuan = useStore((s) => s.agentYuan) || 'lynn';
  const [localQwenStatus, setLocalQwenStatus] = useState<LocalQwenStatus | null>(null);
  const showLocalQwenRuntime = isLocalQwenModel(currentModel)
    || isLocalQwenModel(utilityModel)
    || isLocalQwenModel(utilityLargeModel);

  useEffect(() => {
    if (!showLocalQwenRuntime) {
      setLocalQwenStatus(null);
      return undefined;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        const res = await hanaFetch('/api/local-qwen35-9b/status', { timeout: 8000 });
        const data = await res.json();
        if (!cancelled) setLocalQwenStatus(data);
      } catch {
        // Keep the last known state. The status chip should never flicker to a false offline state.
      }
    };
    void refresh();
    const id = window.setInterval(refresh, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [showLocalQwenRuntime]);

  const meta = useMemo(() => {
    const parts: string[] = [];
    const chat = formatModelTag('chat', currentModel, agentYuan, 'chat', localQwenStatus);
    const tool = formatModelTag('tool', utilityModel, agentYuan, 'utility', localQwenStatus);
    const large = formatModelTag('large', utilityLargeModel, agentYuan, 'utility_large', localQwenStatus);

    if (chat) parts.push(chat);
    if (tool) parts.push(tool);
    if (large) parts.push(large);

    return parts;
  }, [agentYuan, currentModel, localQwenStatus, utilityModel, utilityLargeModel]);

  if (wsState === 'connected' && meta.length === 0) return null;

  return (
    <div className={styles.bar}>
      {meta.length > 0 && (
        <div className={styles.metaRow}>
          {meta.map((item) => (
            <span
              key={item}
              className={styles.metaChip}
              title={item.includes('默认模型') ? getBrainComplianceNote() : item}
            >
              {item}
            </span>
          ))}
        </div>
      )}
      {wsState === 'reconnecting' && (
        <span className={styles.text}>{t('status.reconnecting')} ({attempt})</span>
      )}
      {wsState === 'disconnected' && (
        <>
          <span className={styles.text}>{t('status.disconnected')}</span>
          <button className={styles.reconnect} onClick={() => connectWebSocket()}>
            {t('status.reconnect')}
          </button>
        </>
      )}
    </div>
  );
}
