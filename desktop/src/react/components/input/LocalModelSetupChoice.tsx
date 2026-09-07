import catalog from '../../../../../shared/qwen38-local-models.json';
import styles from './LocalModelSetupChoice.module.css';

export const localModelCatalog = catalog;
export function getLocalModelTier(id?: string | null) {
  return catalog.tiers.find(tier => tier.modelId === id) || catalog.tiers[0];
}

export function LocalModelSetupChoice({ value, recommendedId, onChange, disabled, onHelp }: {
  value: string; recommendedId?: string | null; onChange: (id: string) => void;
  disabled?: boolean; onHelp: () => void;
}) {
  const tier = getLocalModelTier(value);
  const total = tier.expectedSize + catalog.draft.expectedSize;
  return <div className={styles.choice}>
    <label>安装方案
      <select aria-label="本地模型安装方案" value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>
        {catalog.tiers.map(item => <option key={item.modelId} value={item.modelId}>
          {item.quantization} + Q4 DFlash2 · {item.memoryGib === 24 ? '24GB 及以上' : '16GB 档'}
          {item.modelId === recommendedId ? '（本机推荐）' : ''}
        </option>)}
      </select>
    </label>
    {!recommendedId && <button type="button" disabled={disabled} onClick={() => onChange(value)}>已了解显存要求，手动选择此方案</button>}
    <p>{tier.label} · 主模型 {(tier.expectedSize / 1e9).toFixed(2)} GB + DFlash2 1.14 GB
      {' · '}模型共 {(total / 1e9).toFixed(2)} GB，建议预留 {Math.ceil(total * 1.1 / 1e9 + 1)} GB 磁盘空间。</p>
    <p>一键安装会检查或下载兼容的 llama.cpp，分别校验两个文件，然后以 {tier.contextSize / 1024}K 上下文、单并发启动。
      16GB 档余量较紧；其他程序占用显存时可能需要调整。此次安装不含视觉组件。</p>
    <div>
      <a href={catalog.modelCardUrl} target="_blank" rel="noopener noreferrer" onClick={event => {
        if (window.platform?.openExternal) { event.preventDefault(); void window.platform.openExternal(catalog.modelCardUrl); }
      }}>查看模型卡与详细说明</a>
      {' · '}<button type="button" onClick={onHelp}>让 Lynn 帮我部署</button>
    </div>
  </div>;
}

export async function requestLocalModelHelp(modelId: string, hardware: unknown, error?: string | null) {
  const platform = window.platform as typeof window.platform & {
    requestLocalModelHelp?: (payload: { modelId: string; hardware: unknown; error?: string | null }) => Promise<{ ok: boolean }>;
  };
  if (!platform?.requestLocalModelHelp) throw new Error('请在 Lynn 桌面端使用部署助手');
  const result = await platform.requestLocalModelHelp({ modelId, hardware, error });
  if (!result?.ok) throw new Error('暂时无法打开对话，请稍后重试');
}
