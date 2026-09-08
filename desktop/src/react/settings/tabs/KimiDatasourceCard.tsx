import { useEffect, useState } from 'react';
import { hanaFetch } from '../api';
import { t } from '../helpers';
import styles from '../Settings.module.css';

interface Candidate { bundled?: boolean; id: string; name: string; version: string; root: string; enabledInKimi: boolean; config: { command: string; args: string[] } }
interface Login { status: string; url?: string; code?: string; qr?: string; error?: string }

export function KimiDatasourceCard({ onChanged }: { onChanged: () => Promise<void> }) {
  const [home, setHome] = useState('');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [scannedHome, setScannedHome] = useState('');
  const [scanned, setScanned] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [login, setLogin] = useState<Login>({ status: 'idle' });
  const request = async (action: string, body?: unknown, method = 'POST') => {
    const res = await hanaFetch(`/api/mcp/kimi/${action}`, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    return res.json();
  };
  useEffect(() => {
    let live = true;
    void request('login', undefined, 'GET').then(state => { if (live) setLogin(state); }).catch(() => {});
    void request('catalog', undefined, 'GET').then(data => { if (live) setCandidates(data.candidates || []); }).catch(() => {});
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (login.status !== 'waiting') return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const state = await request('login', undefined, 'GET');
        if (!live) return;
        setLogin(state);
        if (state.status === 'waiting') timer = setTimeout(poll, 1500);
        if (state.status === 'complete') await onChanged();
      } catch (error) { if (live) { setMessage(String(error)); timer = setTimeout(poll, 3000); } }
    };
    timer = setTimeout(poll, 500);
    return () => { live = false; clearTimeout(timer); };
  }, [login.status, onChanged]);
  const perform = async (run: () => Promise<void>) => {
    setBusy(true); setMessage('');
    try { await run(); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const buttonClass = styles['settings-save-btn-sm'];
  return <section className={styles['settings-section']} aria-label="Kimi Datasource">
    <h2 className={styles['settings-section-title']}>Kimi Datasource</h2>
    <p className={styles['settings-hint']}>{t('settings.mcp.kimi.description')}</p>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
      <button className={buttonClass} disabled={busy || login.status === 'waiting'} onClick={() => void perform(async () => setLogin(await request('login', {})))}>{t('settings.mcp.kimi.login')}</button>
      <button className={buttonClass} onClick={() => window.platform?.openExternal?.('https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/customization/plugins.md#kimi-datasource')}>{t('settings.mcp.kimi.install')}</button>
    </div>
    <details style={{ marginTop: 12 }}><summary>{t('settings.mcp.kimi.localOptions')}</summary>
    <label className={styles['settings-field-label']} htmlFor="kimi-home">{t('settings.mcp.kimi.home')}</label>
    <input id="kimi-home" className={styles['settings-input']} value={home} placeholder={t('settings.mcp.kimi.homePlaceholder')}
      disabled={busy || login.status === 'waiting'} onChange={e => { setHome(e.target.value); setScanned(false); setCandidates(items => items.filter(item => item.bundled)); }} />
      <button className={buttonClass} disabled={busy} onClick={() => void perform(async () => {
        const data = await request('scan', { home }); setCandidates(data.candidates); setScannedHome(data.home); setScanned(true); setMessage(data.diagnostics.join('\n'));
      })}>{t('settings.mcp.kimi.scan')}</button>
    </details>
    {scanned && candidates.length === 0 && <p>{t('settings.mcp.kimi.notFound')}</p>}
    {candidates.map(candidate => <div key={candidate.id} style={{ marginTop: 12 }}>
      <strong>Kimi Datasource {candidate.version} {candidate.bundled ? t('settings.mcp.kimi.bundled') : t('settings.mcp.kimi.local')}</strong>
      {!candidate.bundled && <p style={{ overflowWrap: 'anywhere' }}>{candidate.root}</p>}
      <details><summary>{t('settings.mcp.kimi.command')}</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(candidate.config, null, 2)}</pre></details>
      <button className={buttonClass} disabled={busy} onClick={() => void perform(async () => {
        const data = await request('import', { home: scannedHome, id: candidate.id });
        setMessage(data.server?.connected ? t('settings.mcp.kimi.connected') : data.server?.lastError || t('settings.mcp.kimi.saved'));
        await onChanged();
      })}>{t('settings.mcp.kimi.enable')}</button>
    </div>)}
    {login.status === 'waiting' && <div role="status">
      <p>{t('settings.mcp.kimi.waiting')}</p>
      {login.qr && <img src={login.qr} alt={t('settings.mcp.kimi.qrAlt')} width={220} height={220} />}
      {login.code && <p><code>{login.code}</code></p>}
      {login.url && <button className={buttonClass} onClick={() => window.platform?.openExternal?.(login.url!)}>{t('settings.mcp.kimi.openLogin')}</button>}
      <button className={buttonClass} onClick={() => void perform(async () => setLogin(await request('login', undefined, 'DELETE')))}>{t('settings.mcp.kimi.cancel')}</button>
    </div>}
    {login.status === 'complete' && <p role="status">{t('settings.mcp.kimi.loggedIn')}</p>}
    {(message || login.error) && <p role="status" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{message || login.error}</p>}
  </section>;
}
