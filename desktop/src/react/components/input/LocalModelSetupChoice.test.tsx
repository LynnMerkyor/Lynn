// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { LocalModelSetupChoice, localModelCatalog, requestLocalModelHelp } from './LocalModelSetupChoice';

afterEach(() => vi.unstubAllGlobals());
describe('local model setup choice', () => {
  it.each(localModelCatalog.tiers)('renders the exact $quantization package with help and source links', tier => {
    const html = renderToStaticMarkup(<LocalModelSetupChoice value={tier.modelId} recommendedId={tier.modelId} onChange={() => {}} onHelp={() => {}} />);
    expect(html).toContain(tier.label);
    expect(html).toContain(((tier.expectedSize + localModelCatalog.draft.expectedSize) / 1e9).toFixed(2));
    expect(html).toContain(localModelCatalog.modelCardUrl);
    expect(html).toContain('让 Lynn 帮我部署');
    expect(html).not.toContain('Coding100 82/100');
    expect(html).not.toContain('MTP');
  });
  it('keeps unknown hardware explicit and offers manual selection', () => {
    const html = renderToStaticMarkup(<LocalModelSetupChoice value={localModelCatalog.defaultModelId} onChange={() => {}} onHelp={() => {}} />);
    expect(html).toContain('手动选择此方案');
    expect(html).not.toContain('本机推荐');
  });
  it('requests a draft handoff only after the user invokes help', async () => {
    const request = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('window', { platform: { requestLocalModelHelp: request } });
    renderToStaticMarkup(<LocalModelSetupChoice value={localModelCatalog.q2ModelId} onChange={() => {}} onHelp={() => {}} />);
    expect(request).not.toHaveBeenCalled();
    await requestLocalModelHelp(localModelCatalog.q2ModelId, { accelerator_memory_gib: 16 }, 'load failed');
    expect(request).toHaveBeenCalledExactlyOnceWith({ modelId: localModelCatalog.q2ModelId, hardware: { accelerator_memory_gib: 16 }, error: 'load failed' });
  });
  it('switches the displayed package and opens help only on an explicit click', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const help = vi.fn();
    function Choice() {
      const [id, setId] = React.useState(localModelCatalog.defaultModelId);
      return <LocalModelSetupChoice value={id} recommendedId={localModelCatalog.defaultModelId} onChange={setId} onHelp={help} />;
    }
    try {
      await act(async () => root.render(<Choice />));
      expect(host.textContent).toContain('18.18 GB');
      const select = host.querySelector('select')!;
      await act(async () => {
        select.value = localModelCatalog.q2ModelId;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(host.textContent).toContain('14.14 GB');
      expect(host.textContent).toContain('4K 上下文');
      expect(help).not.toHaveBeenCalled();
      const button = Array.from(host.querySelectorAll('button')).find(node => node.textContent === '让 Lynn 帮我部署')!;
      await act(async () => button.click());
      expect(help).toHaveBeenCalledOnce();
      expect(host.querySelector('a')?.href).toBe(localModelCatalog.modelCardUrl);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
