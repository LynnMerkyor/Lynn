import { useEffect, useState } from 'react';
import { hanaFetch } from '../api';
import styles from '../Settings.module.css';

interface State { status: string; authorizationUrl?: string; redirectUri?: string; error?: string }
export function McpOAuthControls({ name, onConnected }: { name: string; onConnected: () => Promise<void> }) {
  const [state, setState] = useState<State>({ status: 'idle' });
  const [busy, setBusy] = useState(false);
  const isZh = document.documentElement.lang.startsWith('zh');
  const endpoint = `/api/mcp/oauth/${encodeURIComponent(name)}`;
  useEffect(() => {
    let live = true;
    setState({ status: 'idle' });
    const poll = async () => {
      try { const data = await (await hanaFetch(endpoint)).json(); if (!live) return; setState(data); }
      catch (error) { if (live) setState({ status: 'failed', error: String(error) }); }
    };
    void poll();
    return () => { live = false; };
  }, [endpoint]);
  useEffect(() => {
    if (state.status !== 'waiting') return;
    let live = true; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const data = await (await hanaFetch(endpoint)).json(); if (!live) return; setState(data);
        if (data.status === 'waiting') timer = setTimeout(poll, 1500);
        if (data.status === 'authorized') { await hanaFetch('/api/mcp/reload', { method: 'POST' }); await onConnected(); }
      } catch (error) { if (live) setState({ status: 'failed', error: String(error) }); }
    };
    timer = setTimeout(poll, 1500);
    return () => { live = false; clearTimeout(timer); };
  }, [state.status, endpoint, onConnected]);
  const run = async (method: string) => {
    setBusy(true);
    try {
      const data = await (await hanaFetch(endpoint, { method })).json();
      setState(method === 'DELETE' ? { status: 'idle' } : data);
      if (method === 'DELETE') await onConnected();
    } catch (error) { setState({ status: 'failed', error: String(error) }); }
    finally { setBusy(false); }
  };
  return <div style={{ margin: '12px 0' }}>
    <p role="status">{state.status === 'authorized' ? (isZh ? 'OAuth 已授权' : 'OAuth authorized') : state.status === 'waiting' ? (isZh ? '等待浏览器授权' : 'Waiting for browser authorization') : (isZh ? '使用浏览器登录 MCP 服务' : 'Sign in to this MCP service in your browser')}</p>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      <button className={styles['settings-save-btn-sm']} disabled={busy || state.status === 'waiting'} onClick={() => void run('POST')}>{isZh ? '开始登录' : 'Sign in'}</button>
      {state.authorizationUrl && <button className={styles['settings-save-btn-sm']} onClick={() => window.platform?.openExternal?.(state.authorizationUrl!)}>{isZh ? '打开授权页面' : 'Open authorization page'}</button>}
      <button className={styles['settings-save-btn-sm']} disabled={busy} onClick={() => void run('DELETE')}>{isZh ? '断开授权' : 'Disconnect'}</button>
    </div>
    {state.redirectUri && <p>{isZh ? '本机回调地址：' : 'Local callback: '}<code>{state.redirectUri}</code></p>}
    {state.error && <p role="alert">{state.error}</p>}
  </div>;
}
