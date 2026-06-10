/**
 * SessionCostChip — 会话累计云 token/费用芯片(StepFun 一条龙:全 token 云计费)。
 * 数据:usage-slice(server context_usage 回包 turnUsage,timestamp 去重累计)。
 * 挂在输入区 ContextRing 旁(用户视线所在的"模型芯片"那排)。
 */
import { useMemo } from 'react';
import { useStore } from '../../stores';
import styles from './InputArea.module.css';

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function SessionCostChip() {
  const currentSessionPath = useStore((s) => s.currentSessionPath);
  const sessionUsage = useStore((s) => s.sessionUsage);

  const view = useMemo(() => {
    const u = currentSessionPath ? sessionUsage[currentSessionPath] : undefined;
    if (!u || u.totalTokens <= 0) return null;
    const cachePct = u.input + u.cacheRead > 0 ? Math.round((u.cacheRead / (u.input + u.cacheRead)) * 100) : 0;
    const cost = u.costTotal > 0 ? ` · $${u.costTotal >= 0.1 ? u.costTotal.toFixed(2) : u.costTotal.toFixed(4)}` : '';
    const t = window.t ?? ((k: string) => k);
    const cacheLabel = (() => { const v = t('status.usage.cache'); return v && v !== 'status.usage.cache' ? v : '缓存'; })();
    return {
      text: `Σ ${fmt(u.totalTokens)}${cost}`,
      title: `${t('status.usage.tip') !== 'status.usage.tip' ? t('status.usage.tip') : '本会话累计云端 token 消耗'}\nin ${fmt(u.input)} · out ${fmt(u.output)} · ${cacheLabel} ${cachePct}%${cost} · ${u.turns} 轮`,
    };
  }, [currentSessionPath, sessionUsage]);

  if (!view) return null;
  return (
    <span className={styles['session-cost-chip']} title={view.title}>
      {view.text}
    </span>
  );
}
