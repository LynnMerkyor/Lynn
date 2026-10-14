import { useCallback, useEffect, useState } from 'react';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { useI18n } from '../hooks/use-i18n';
import { useStore } from '../stores';
import { deleteSession } from '../stores/session-actions';
import styles from './SessionList.module.css';

type ArchivedSession = { path: string; title: string; agentId: string; modified: string };

export function ArchivedSessions() {
  const { t } = useI18n();
  const activeSessions = useStore(state => state.sessions);
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<ArchivedSession[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const response = await hanaFetch('/api/sessions/archived');
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error || `${response.status}`);
    return data.sessions as ArchivedSession[];
  }, []);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setBusy(true);
    load().then(items => { if (active) { setSessions(items); setError(''); } })
      .catch(failure => { if (active) setError(String(failure.message || failure)); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [open, activeSessions, load]);

  const remove = async (targets: ArchivedSession[], all: boolean) => {
    setBusy(true);
    setError('');
    try {
      if (all) {
        const response = await hanaFetch('/api/sessions/cleanup', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: targets.map(item => item.path) }),
        });
        const data = await response.json();
        if (!response.ok || data.error || !data.ok) throw new Error(data.error || (data.failures || []).map((item: { error: string }) => item.error).join('; ') || t('session.deleteFailed'));
      } else if (!await deleteSession(targets[0].path)) throw new Error(t('session.deleteFailed'));
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally {
      try { setSessions(await load()); } catch (failure) { setError(String(failure)); }
      setBusy(false);
    }
  };

  const confirm = (targets: ArchivedSession[], all = false) => useStore.getState().setPendingConfirm({
    title: t(all ? 'session.clearArchived' : 'session.delete'),
    message: all ? t('session.clearArchivedConfirm', { count: String(targets.length) }) : t('session.deleteConfirm', { name: targets[0].title }),
    tone: 'danger', confirmLabel: t(all ? 'session.clearArchived' : 'session.delete'),
    onConfirm: () => { void remove(targets, all); },
  });

  return (
    <section aria-label={t('session.archived')}>
      <button type="button" className={styles.sessionGroupHeader} aria-expanded={open} onClick={() => setOpen(value => !value)}>{t('session.archived')}</button>
      {open && <>
        <button type="button" disabled={busy || sessions.length === 0} onClick={() => confirm(sessions, true)}>{t('session.clearArchived')}</button>
        {busy && <p role="status">{t('session.archiveLoading')}</p>}
        {error && <p role="alert">{error}</p>}
        {!busy && !error && sessions.length === 0 && <p>{t('session.archiveEmpty')}</p>}
        {sessions.map(session => <div key={session.path} className={styles.sessionItem}>
          <div className={styles.sessionItemTitle} title={session.title}>{session.title}</div>
          <div className={styles.sessionItemMeta}>{session.agentId} · {new Date(session.modified).toLocaleString()}</div>
          <button type="button" disabled={busy} aria-label={`${t('session.delete')} ${session.title}`} onClick={() => confirm([session])}>{t('session.delete')}</button>
        </div>)}
      </>}
    </section>
  );
}
