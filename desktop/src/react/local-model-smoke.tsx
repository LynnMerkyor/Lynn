// Loaded only by the isolated UI-smoke fixture; never downloads or starts models.
import { useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LocalModelSetupChoice, localModelCatalog } from './components/input/LocalModelSetupChoice';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

export function closeLocalModelSmoke() {
  root?.unmount();
  container?.remove();
  root = null;
  container = null;
}

function Fixture({ unknown }: { unknown: boolean }) {
  const [id, setId] = useState(localModelCatalog.tiers[0].modelId);
  const [help, setHelp] = useState(false);
  return <section data-local-model-smoke data-help-clicked={help} style={{
    width: '100%', padding: 20, boxSizing: 'border-box', color: 'var(--text)',
    background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 16,
  }}>
    <h2>本地模型安装</h2>
    <LocalModelSetupChoice value={id} recommendedId={unknown ? null : localModelCatalog.tiers[0].modelId}
      onChange={setId} onHelp={() => setHelp(true)} />
  </section>;
}

export function showLocalModelSmoke(unknown = false) {
  closeLocalModelSmoke();
  container = document.createElement('div');
  Object.assign(container.style, {
    position: 'fixed', zIndex: '99999', inset: '20px', width: 'min(680px, calc(100% - 40px))',
    marginInline: 'auto', maxHeight: 'calc(100% - 40px)', overflow: 'auto',
  });
  document.body.append(container);
  root = createRoot(container);
  root.render(<Fixture unknown={unknown} />);
}
