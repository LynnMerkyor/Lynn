import { useEffect, useState } from 'react';
import { hanaFetch } from '../api';
import { useSettingsStore } from '../store';
import styles from '../Settings.module.css';
interface State { error?: string; enabled: boolean; urls: string[]; secure: boolean; publicUrl: string; devices: Array<{ id: string; name: string }> }
export function MobileAccessCard() {
  const ready = useSettingsStore(state => state.ready);
  const [state, setState] = useState<State>({ enabled: false, urls: [], secure: false, publicUrl: '', devices: [] });
  const [publicUrl, setPublicUrl] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [pair, setPair] = useState<{ qr: string; url: string; expiresAt: number } | null>(null);
  const isZh = document.documentElement.lang.startsWith('zh');
  const load = async () => { const data = await (await hanaFetch('/api/mobile/settings')).json(); setState(data); setPublicUrl(data.publicUrl); };
  useEffect(() => { if (ready) void load().catch(error => setError(String(error))); }, [ready]);
  const perform = async (action: () => Promise<void>) => { setBusy(true); setError(''); try { await action(); } catch (error) { setError(String(error)); } finally { setBusy(false); } };
  return <section className={styles['settings-section']}>
    <h2 className={styles['settings-section-title']}>{isZh ? '手机访问' : 'Mobile access'}</h2>
    <p>{isZh ? '在同一网络中扫码配对，继续电脑上的会话并收取文件。' : 'Pair a device on the same network to continue conversations and receive files.'}</p>
    <label className={styles['settings-toggle-row']}><input type="checkbox" disabled={busy || !ready} checked={state.enabled} onChange={event => void perform(async () => {
      const data = await (await hanaFetch('/api/mobile/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: event.target.checked, publicUrl }) })).json(); setState(data); setPair(null);
    })} />{isZh ? '启用手机访问' : 'Enable mobile access'}</label>
    <details><summary>{isZh ? 'HTTPS 访问地址（可选）' : 'HTTPS public address (optional)'}</summary><input className={styles['settings-input']} value={publicUrl} onChange={event => setPublicUrl(event.target.value)} placeholder="https://lynn.example.com" aria-label="Mobile HTTPS URL" />
      <button className={styles['settings-save-btn-sm']} disabled={busy} onClick={() => void perform(async () => { setState(await (await hanaFetch('/api/mobile/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: state.enabled, publicUrl }) })).json()); setPair(null); })}>{isZh ? '保存地址' : 'Save address'}</button>
    </details>
    {state.enabled && <>
      <p>{state.urls.join(' · ')}</p>
      {!state.secure && <p className={styles['settings-hint']}>{isZh ? '局域网地址可在浏览器使用；添加到手机主屏幕需要配置 HTTPS。' : 'The LAN address works in a browser. HTTPS is required to install on the home screen.'}</p>}
      <button className={styles['settings-save-btn-sm']} disabled={busy} onClick={() => void perform(async () => setPair(await (await hanaFetch('/api/mobile/pairing', { method: 'POST' })).json()))}>{isZh ? '生成配对二维码' : 'Generate pairing QR code'}</button>
      {pair && <div><img src={pair.qr} width="240" height="240" alt={isZh ? '手机配对二维码' : 'Mobile pairing QR code'} /><p>{isZh ? '一次有效，过期时间：' : 'Single use, expires: '}{new Date(pair.expiresAt).toLocaleTimeString()}</p><code style={{ overflowWrap: 'anywhere' }}>{pair.url}</code><button className={styles['settings-save-btn-sm']} onClick={() => void perform(load)}>{isZh ? '刷新设备列表' : 'Refresh devices'}</button></div>}
    </>}
    {state.devices.map(device => <p key={device.id}>{device.name} <button className={styles['settings-save-btn-sm']} disabled={busy} onClick={() => void perform(async () => { await hanaFetch(`/api/mobile/devices/${device.id}`, { method: 'DELETE' }); await load(); })}>{isZh ? '撤销访问' : 'Revoke access'}</button></p>)}
    {(error || state.error) && <p role="alert">{error || state.error}</p>}
  </section>;
}
