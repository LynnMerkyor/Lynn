import React, { useState, useEffect, useRef } from 'react';
import { useSettingsStore } from '../../store';
import { hanaFetch } from '../../api';
import { t, lookupModelMeta, autoSaveConfig, CONTEXT_PRESETS, OUTPUT_PRESETS, resolveProviderForModel } from '../../helpers';
import { ComboInput } from '../../widgets/ComboInput';
import { Toggle } from '../../widgets/Toggle';
import styles from '../../Settings.module.css';
import { notifyModelsChanged } from './model-change-events';

type ProviderModelEntry = string | {
  id?: string;
  name?: string;
  displayName?: string;
  context?: number | null;
  maxOutput?: number | null;
  [key: string]: unknown;
};

function modelEntryId(entry: ProviderModelEntry): string {
  if (typeof entry === 'string') return entry;
  return typeof entry?.id === 'string' ? entry.id : '';
}

function modelEntryMeta(entry: ProviderModelEntry | undefined) {
  if (!entry || typeof entry === 'string') return {};
  return entry;
}

function positiveInt(value: string): number | null {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function ModelEditPanel({ modelId, providerId, anchorEl, onClose, onRefresh }: {
  modelId: string;
  providerId?: string;
  anchorEl: HTMLElement | null;
  onClose: () => void;
  onRefresh?: () => Promise<void>;
}) {
  const { showToast } = useSettingsStore();
  const config = useSettingsStore.getState().settingsConfig;
  const resolvedProviderId = providerId || resolveProviderForModel(modelId);
  const providerModels = (resolvedProviderId ? config?.providers?.[resolvedProviderId]?.models : []) as ProviderModelEntry[] | undefined;
  const providerModelEntry = providerModels?.find(entry => modelEntryId(entry) === modelId);
  const providerMeta = modelEntryMeta(providerModelEntry);
  const meta = { ...(lookupModelMeta(modelId) || {}), ...providerMeta };
  const [displayName, setDisplayName] = useState(meta.displayName || '');
  const [ctxVal, setCtxVal] = useState(String(meta.context || ''));
  const [outVal, setOutVal] = useState(String(meta.maxOutput || ''));
  const [vision, setVision] = useState<boolean>(meta.vision === true);
  const [reasoning, setReasoning] = useState<boolean>(meta.reasoning === true);
  const panelRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({});

  useEffect(() => {
    setStyle({
      position: 'fixed',
      left: '50%',
      top: '50%',
      transform: 'translate(-50%, -50%)',
      zIndex: 9999,
      width: 360,
    });
  }, [anchorEl]);

  const save = async () => {
    const entry: Record<string, string | number | boolean> = {};
    const name = displayName.trim();
    const ctx = ctxVal.trim();
    const maxOut = outVal.trim();
    if (name) entry.displayName = name;
    if (ctx) entry.context = parseInt(ctx);
    if (maxOut) entry.maxOutput = parseInt(maxOut);
    entry.vision = vision;
    entry.reasoning = reasoning;
    const config = useSettingsStore.getState().settingsConfig;
    const currentOverrides = config?.models?.overrides || {};
    await autoSaveConfig({ models: { overrides: { ...currentOverrides, [modelId]: entry } } });
    const targetProviderId = providerId || resolveProviderForModel(modelId);
    const providerConfig = targetProviderId ? useSettingsStore.getState().settingsConfig?.providers?.[targetProviderId] : null;
    if (targetProviderId && providerConfig) {
      const models = (providerConfig.models || []) as ProviderModelEntry[];
      const found = models.some(item => modelEntryId(item) === modelId);
      const nextModels = (found ? models : [...models, modelId]).map((item) => {
        if (modelEntryId(item) !== modelId) return item;
        const next: Record<string, unknown> = typeof item === 'object' && item !== null ? { ...item, id: modelId } : { id: modelId };
        if (name) next.name = name;
        else delete next.name;
        const context = positiveInt(ctx);
        if (context) next.context = context;
        else delete next.context;
        const maxOutput = positiveInt(maxOut);
        if (maxOutput) next.maxOutput = maxOutput;
        else delete next.maxOutput;
        next.vision = vision;
        next.reasoning = reasoning;
        return next;
      });
      const res = await hanaFetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers: { [targetProviderId]: { models: nextModels } } }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const modelsRes = await hanaFetch('/api/models');
      const modelsData = await modelsRes.json();
      if (modelsData?.error) throw new Error(modelsData.error);
      const current = modelsData?.models?.find?.((model: { id?: string; provider?: string; isCurrent?: boolean }) => model?.isCurrent);
      if (current?.id === modelId && (!current.provider || current.provider === targetProviderId)) {
        const setRes = await hanaFetch('/api/models/set', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelId, provider: targetProviderId }),
        });
        const setData = await setRes.json().catch(() => null);
        if (setData?.error) throw new Error(setData.error);
      }
      await onRefresh?.();
      notifyModelsChanged();
    }
    showToast(t('settings.saved'), 'success');
    onClose();
  };

  return (
    <>
    <div className={styles['pv-model-edit-overlay']} onClick={onClose} />
    <div ref={panelRef} className={styles['pv-model-edit-card']} style={style}>
      <div className={styles['pv-model-edit-field']}>
        <label className={styles['pv-model-edit-label']}>ID</label>
        <span className={styles['pv-model-edit-id']}>{modelId}</span>
      </div>
      <div className={styles['pv-model-edit-field']}>
        <label className={styles['pv-model-edit-label']}>{t('settings.api.displayName')}</label>
        <input
          className={styles['settings-input']}
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder={modelId}
        />
      </div>
      <div className={styles['pv-model-edit-row']}>
        <div className={styles['pv-model-edit-field']}>
          <label className={styles['pv-model-edit-label']}>{t('settings.api.contextLength')}</label>
          <ComboInput presets={CONTEXT_PRESETS} value={ctxVal} onChange={setCtxVal} placeholder="131072" />
        </div>
        <div className={styles['pv-model-edit-field']}>
          <label className={styles['pv-model-edit-label']}>{t('settings.api.maxOutput')}</label>
          <ComboInput presets={OUTPUT_PRESETS} value={outVal} onChange={setOutVal} placeholder="16384" />
        </div>
      </div>
      <div className={styles['pv-model-edit-row']}>
        <div className={styles['pv-model-edit-field']}>
          <label className={styles['pv-model-edit-label']}>{t('settings.api.vision')}</label>
          <Toggle on={vision} onChange={setVision} />
        </div>
        <div className={styles['pv-model-edit-field']}>
          <label className={styles['pv-model-edit-label']}>{t('settings.api.reasoning')}</label>
          <Toggle on={reasoning} onChange={setReasoning} />
        </div>
      </div>
      <div className={styles['pv-model-edit-actions']}>
        <button type="button" className={styles['pv-add-form-btn']} onClick={onClose}>{t('settings.api.cancel')}</button>
        <button type="button" className={`${styles['pv-add-form-btn']} ${styles['primary']}`} onClick={save}>{t('settings.api.save')}</button>
      </div>
    </div>
    </>
  );
}
