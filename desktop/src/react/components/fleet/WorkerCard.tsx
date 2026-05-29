/**
 * WorkerCard — one worker's live view: status, diff, tests, changed files
 * (out-of-scope ones flagged red), recent log, finish/error summary.
 */
import type { FleetWorkerView } from './fleet-reducer';
import s from './Fleet.module.css';

const STATUS_LABEL: Record<string, string> = {
  queued: 'queued',
  running: 'running',
  waiting_approval: 'review',
  blocked: 'blocked',
  completed: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
};

export function WorkerCard({ worker }: { worker: FleetWorkerView }) {
  const { diffStat } = worker;
  return (
    <div className={s.workerCard} data-status={worker.status} data-blocked={worker.hasForbiddenEdit ? '1' : '0'}>
      <div className={s.workerHead}>
        <span className={s.workerAgent}>{worker.agent ?? 'worker'}</span>
        <span className={s.workerBranch}>{worker.branch ?? worker.workerId}</span>
        {worker.hasForbiddenEdit && <span className={s.badgeScope} title="out-of-scope edit">out-of-scope</span>}
        <span className={s.workerStatus}>{STATUS_LABEL[worker.status] ?? worker.status}</span>
      </div>

      {diffStat && (
        <div className={s.workerDiff}>
          +{diffStat.insertions} -{diffStat.deletions} · {diffStat.files} file(s)
        </div>
      )}

      {worker.tests.length > 0 && (
        <ul className={s.workerTests}>
          {worker.tests.map((t, idx) => (
            <li key={`${t.command}-${idx}`} data-ok={t.running ? 'run' : t.ok ? 'ok' : 'fail'}>
              {t.command} — {t.running ? 'running…' : t.ok ? `ok${t.summary ? ` · ${t.summary}` : ''}` : 'failed'}
            </li>
          ))}
        </ul>
      )}

      {worker.changedFiles.length > 0 && (
        <ul className={s.workerFiles}>
          {worker.changedFiles.map((f) => (
            <li key={f.path} data-forbidden={f.forbidden ? '1' : '0'}>
              {(f.action ?? 'edit')} {f.path}
              {f.forbidden ? '  (forbidden)' : ''}
            </li>
          ))}
        </ul>
      )}

      {worker.log.length > 0 && (
        <div className={s.workerLog}>{worker.log.slice(-4).join('\n')}</div>
      )}

      {worker.finished && (
        <div className={s.workerFinished}>
          {worker.finished.summary}
          {worker.finished.commit ? ` (${worker.finished.commit})` : ''}
        </div>
      )}

      {worker.error && (
        <div className={s.workerError}>
          error {worker.error.code}: {worker.error.message}
        </div>
      )}
    </div>
  );
}
