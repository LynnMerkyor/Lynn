import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../stores';
import { useI18n } from '../../hooks/use-i18n';
import type { Session } from '../../types';
import { branchSession, consumeInsights, switchSession } from '../../stores/session-actions';
import s from './Desk.module.css';

type WorkState = 'active' | 'blocked' | 'risk' | 'done';

const GROUP_LIMIT = 8;

function sessionTitle(
  session: Session,
  labels: { current: string; untitled: string },
  opts: { current?: boolean } = {},
): string {
  const raw = session.digest?.objective || session.title || session.firstMessage || '';
  const trimmed = raw.trim();
  if (!trimmed) return opts.current ? labels.current : labels.untitled;
  return trimmed.length > 44 ? trimmed.slice(0, 43).trimEnd() + '…' : trimmed;
}

function formatBytes(bytes?: number | null): string {
  if (!bytes || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)}${units[index]}`;
}

function formatTimeLabel(iso: string | null | undefined, locale: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHour = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);
  const relative = new Intl.RelativeTimeFormat(locale || 'zh-CN', { numeric: 'auto' });
  if (diffMin < 1) return relative.format(0, 'minute');
  if (diffMin < 60) return relative.format(-diffMin, 'minute');
  if (diffHour < 24) return relative.format(-diffHour, 'hour');
  if (diffDay < 7) return relative.format(-diffDay, 'day');
  return date.toLocaleDateString(locale || 'zh-CN', { month: 'short', day: 'numeric' });
}

function unreadCount(session: Session): number {
  return (session.insights || []).filter((item) => item.status === 'unread').length;
}

function hasDigest(session: Session): boolean {
  return Boolean(session.digest?.objective?.trim() || session.digest?.summary?.trim());
}

function isRisk(session: Session): boolean {
  return session.health?.level === 'critical' || session.health?.level === 'large';
}

function hasBranchRelation(session: Session, all: Session[]): boolean {
  if (session.topology?.parentSessionPath) return true;
  return all.some((other) => other.topology?.parentSessionPath === session.path);
}

function isHistoryCandidate(session: Session): boolean {
  if (session.topology?.taskStatus === 'archived') return false;
  if (hasDigest(session)) return true;
  if ((session.insights || []).length > 0) return true;
  if (session.topology?.parentSessionPath || session.topology?.branchLabel || session.topology?.summary) return true;
  if ((session.messageCount || 0) > 0) return true;
  return Boolean(session.title?.trim() || session.firstMessage?.trim());
}

// 工作节点 = 当前 / 有 digest / 风险 / 有未读洞察 / 有分支关系 / 有明确 taskStatus;archived 与纯噪音折叠。
function isWorkNode(session: Session, all: Session[], currentPath: string | null): boolean {
  if (session.path === currentPath) return true;
  if (session.topology?.taskStatus === 'archived') return false;
  if (hasDigest(session) || isRisk(session) || unreadCount(session) > 0) return true;
  if (hasBranchRelation(session, all)) return true;
  const ts = session.topology?.taskStatus;
  return ts === 'active' || ts === 'paused' || ts === 'completed';
}

function deriveState(session: Session): WorkState {
  if (isRisk(session)) return 'risk';
  const ts = session.topology?.taskStatus;
  if (ts === 'completed') return 'done';
  if (ts === 'paused') return 'blocked';
  return 'active';
}

const STATE_DOT: Record<WorkState, string> = {
  active: s.mapDotActive,
  blocked: s.mapDotBlocked,
  risk: s.mapDotRisk,
  done: s.mapDotDone,
};

const STATE_CHIP: Record<WorkState, string> = {
  active: s.mapChipActive,
  blocked: s.mapChipBlocked,
  risk: s.mapChipRisk,
  done: s.mapChipDone,
};

function nextLine(session: Session): string {
  const next = session.digest?.nextSteps?.find((step) => step.trim());
  if (next) return next.trim();
  const status = session.digest?.status?.trim();
  if (status) return status;
  const summary = session.digest?.summary?.trim() || session.topology?.summary?.trim();
  return summary || '';
}

function sortWork(a: Session, b: Session, currentPath: string | null): number {
  const ac = a.path === currentPath ? 1 : 0;
  const bc = b.path === currentPath ? 1 : 0;
  if (ac !== bc) return bc - ac;
  const au = unreadCount(a);
  const bu = unreadCount(b);
  if (au !== bu) return bu - au;
  return (new Date(b.modified || 0).getTime() || 0) - (new Date(a.modified || 0).getTime() || 0);
}

export function SessionMapView() {
  const { t, locale } = useI18n();
  const sessions = useStore((state) => state.sessions);
  const currentSessionPath = useStore((state) => state.currentSessionPath);
  const requestInputFocus = useStore((state) => state.requestInputFocus);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const tt = (key: string, fallback: string, vars?: Record<string, string | number>) => {
    const value = t(key, vars);
    return !value || value === key ? fallback : value;
  };
  const titleLabels = {
    current: tt('desk.progress.currentSession', '当前会话'),
    untitled: tt('desk.progress.untitledSession', '未命名会话'),
  };
  const stateLabel = (state: WorkState) => {
    if (state === 'done') return tt('desk.progress.done', '已完成');
    if (state === 'active') return tt('desk.progress.active', '进行中');
    return tt('desk.progress.needsAttention', '需要处理');
  };

  useEffect(() => {
    setSelectedPath(null);
  }, [currentSessionPath]);

  const { attentionItems, recentItems, folded, counts, currentSession } = useMemo(() => {
    const current = sessions.find((sess) => sess.path === currentSessionPath) || null;
    const work = sessions.filter((sess) => isWorkNode(sess, sessions, currentSessionPath));
    const boardWork = work.filter((sess) => sess.path !== currentSessionPath);
    const buckets: Record<WorkState, Session[]> = { active: [], blocked: [], risk: [], done: [] };
    for (const sess of boardWork) buckets[deriveState(sess)].push(sess);
    const sorter = (a: Session, b: Session) => sortWork(a, b, currentSessionPath);
    const activeItems = buckets.active.sort(sorter);
    const stalledItems = [...buckets.risk, ...buckets.blocked].sort(sorter);
    const doneItems = buckets.done.sort(sorter);
    const attention = boardWork
      .filter((sess) => unreadCount(sess) > 0 || isRisk(sess) || deriveState(sess) === 'blocked')
      .sort(sorter)
      .slice(0, GROUP_LIMIT);
    const attentionPaths = new Set(attention.map((sess) => sess.path));
    const recentPool = sessions.filter((sess) =>
      sess.path !== currentSessionPath
      && !attentionPaths.has(sess.path)
      && isHistoryCandidate(sess)
    );
    const recent = (recentPool.length > 0
      ? recentPool
      : sessions.filter((sess) => sess.path !== currentSessionPath && !attentionPaths.has(sess.path)))
      .sort(sorter)
      .slice(0, GROUP_LIMIT);
    return {
      attentionItems: attention,
      recentItems: recent,
      folded: Math.max(0, sessions.length - (current ? 1 : 0) - attention.length - recent.length),
      currentSession: current,
      counts: {
        active: activeItems.length + (current ? 1 : 0),
        stalled: stalledItems.length,
        done: doneItems.length,
        unread: work.reduce((sum, sess) => sum + unreadCount(sess), 0),
        recent: recent.length,
      },
    };
  }, [sessions, currentSessionPath]);

  const parentOf = (sess: Session): Session | null =>
    sess.topology?.parentSessionPath
      ? sessions.find((p) => p.path === sess.topology?.parentSessionPath) || null
      : null;

  const totalWork = counts.active + counts.stalled + counts.done;

  const pulse = totalWork === 0
    ? tt('desk.progress.noTrackedSessions', '还没有可跟进的会话')
    : [
        counts.active > 0 ? tt('desk.progress.activeCount', `${counts.active} 进行中`, { count: counts.active }) : '',
        counts.stalled > 0 ? tt('desk.progress.attentionCount', `${counts.stalled} 需要处理`, { count: counts.stalled }) : '',
        counts.done > 0 ? tt('desk.progress.doneCount', `${counts.done} 已完成`, { count: counts.done }) : '',
      ].filter(Boolean).join(' · ');

  const renderCard = (sess: Session, listItem = false) => {
    const state = deriveState(sess);
    const isSel = selectedPath === sess.path;
    const unread = unreadCount(sess);
    const parent = parentOf(sess);
    const next = nextLine(sess);
    const meta: string[] = [];
    if (parent) meta.push(tt('desk.progress.fromSession', `来自 ${sessionTitle(parent, titleLabels)}`, { title: sessionTitle(parent, titleLabels) }));
    if (sess.topology?.branchLabel) meta.push(sess.topology.branchLabel);
    if (isRisk(sess) && sess.health?.sizeBytes) meta.push(formatBytes(sess.health.sizeBytes));
    if (sess.messageCount) meta.push(tt('desk.progress.messageCount', `${sess.messageCount} 条消息`, { count: sess.messageCount }));
    const time = formatTimeLabel(sess.modified, locale);
    if (time) meta.push(time);

    return (
      <div
        key={sess.path}
        className={`${s.mapCard} ${isSel ? s.mapCardSel : ''}`}
        data-session-card={sess.path}
        role={listItem ? 'listitem' : undefined}
      >
        <button
          type="button"
          className={s.mapCardToggle}
          onClick={() => setSelectedPath(isSel ? null : sess.path)}
          aria-expanded={isSel}
          aria-label={tt('desk.progress.inspectSession', `查看 ${sessionTitle(sess, titleLabels)}`, { title: sessionTitle(sess, titleLabels) })}
        >
          <span className={s.mapCardHead}>
            <span className={`${s.mapDot} ${STATE_DOT[state]}`} aria-hidden="true" />
            <span className={s.mapCardTitle}>{sessionTitle(sess, titleLabels)}</span>
            <span className={`${s.mapChip} ${STATE_CHIP[state]}`}>{stateLabel(state)}</span>
            {unread > 0 && <span className={s.mapCardIns} title={tt('desk.progress.unreadInsights', `${unread} 条未读洞察`, { count: unread })}>{unread}</span>}
          </span>
          {!isSel && next && (
            <span className={s.mapCardNext}>
              <span>{tt('desk.progress.nextStep', '下一步')}</span>
              {next}
            </span>
          )}
          {meta.length > 0 && <span className={s.mapCardMeta}>{meta.join(' · ')}</span>}
        </button>

        {isSel && (
          <div className={s.mapInlineDetail}>
            {sess.digest?.summary && <p className={s.mapSummary}>{sess.digest.summary}</p>}
            {sess.digest?.nextSteps?.length ? (
              <div className={s.mapNextSteps} aria-label={tt('desk.progress.nextSteps', '下一步')}>
                {sess.digest.nextSteps.slice(0, 3).map((item) => <span key={item}>{item}</span>)}
              </div>
            ) : null}
            {unread > 0 && (
              <div className={s.mapInsights}>
                {(sess.insights || []).filter((item) => item.status === 'unread').slice(0, 3).map((item) => (
                  <div key={item.id} className={s.mapInsightItem}>
                    <p title={item.source ? tt('desk.progress.fromSource', `来自 ${item.source}`, { source: item.source }) : undefined}>{item.content}</p>
                    <div className={s.mapInsightActions}>
                      <button
                        type="button"
                        className={s.mapActionBtn}
                        onClick={() => {
                          void consumeInsights(sess.path, [item.id]);
                          useStore.setState({ composerText: item.content, welcomeVisible: false });
                          useStore.getState().requestInputFocus();
                        }}
                      >
                        {tt('desk.progress.apply', '应用')}
                      </button>
                      <button type="button" className={s.mapGhostBtn} onClick={() => { void consumeInsights(sess.path, [item.id]); }}>
                        {tt('desk.progress.ignore', '忽略')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className={s.mapDetailActions}>
              <button type="button" className={s.mapActionBtn} onClick={() => { void switchSession(sess.path); }}>
                {tt('desk.progress.openSession', '打开会话')}
              </button>
              <button type="button" className={s.mapGhostBtn} onClick={() => { void branchSession(sess.path); }}>
                {tt('desk.progress.newBranch', '新建分支')}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderCurrentCard = () => {
    if (!currentSession) return null;
    const state = deriveState(currentSession);
    const next = nextLine(currentSession);
    const unread = unreadCount(currentSession);
    const meta: string[] = [];
    if (currentSession.messageCount) meta.push(tt('desk.progress.messageCount', `${currentSession.messageCount} 条消息`, { count: currentSession.messageCount }));
    const time = formatTimeLabel(currentSession.modified, locale);
    if (time) meta.push(time);
    if (unread > 0) meta.push(tt('desk.progress.insightCount', `${unread} 条洞察`, { count: unread }));
    return (
      <div className={s.mapCurrentCard}>
        <div className={s.mapCurrentTop}>
          <div className={s.mapCurrentCopy}>
            <span className={s.mapCurrentKicker}>{tt('desk.progress.currentSession', '当前会话')}</span>
            <strong>{sessionTitle(currentSession, titleLabels, { current: true })}</strong>
          </div>
          <span className={`${s.mapChip} ${STATE_CHIP[state]}`}>{stateLabel(state)}</span>
        </div>
        {meta.length > 0 && <div className={s.mapCurrentMeta}>{meta.join(' · ')}</div>}
        <div className={s.mapCurrentBody}>
          {next ? (
            <>
              <span>{tt('desk.progress.nextStep', '下一步')}</span>
              <p>{next}</p>
            </>
          ) : (
            <p>{tt('desk.progress.waitingForInput', '正在等待你的下一条输入')}</p>
          )}
        </div>
        <div className={s.mapCurrentActions}>
          <button
            type="button"
            className={s.mapActionBtn}
            onClick={() => {
              requestInputFocus();
            }}
          >
            {tt('desk.progress.continueInput', '继续输入')}
          </button>
          <button type="button" className={s.mapGhostBtn} onClick={() => { void branchSession(currentSession.path); }}>
            {tt('desk.progress.newBranch', '新建分支')}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className={s.sessionMap}>
      {renderCurrentCard()}

      <div className={s.mapRailStats}>
        <span>{pulse}</span>
        {counts.unread > 0 && <span className={s.mapPulseInsight}>{tt('desk.progress.insightCount', `${counts.unread} 条洞察`, { count: counts.unread })}</span>}
      </div>

      {attentionItems.length > 0 && (
        <div className={s.mapSection}>
          <div className={s.mapSectionHead}>{tt('desk.progress.needsAttention', '需要处理')}</div>
          {attentionItems.map((sess) => renderCard(sess))}
        </div>
      )}

      <div className={s.mapCanvasWrap}>
        {recentItems.length === 0 ? (
          <div className={s.mapEmpty}>{tt('desk.progress.noOtherSessions', '暂无其他会话')}</div>
        ) : (
          <div className={s.mapBoard} role="list" aria-label={tt('desk.progress.recentSessions', '最近会话')}>
            <div className={s.mapBoardTitle} role="presentation">{tt('desk.progress.recentSessions', '最近会话')}</div>
            {recentItems.map((sess) => renderCard(sess, true))}
          </div>
        )}
      </div>

      {folded > 0 && (
        <div className={s.mapFolded}>{tt('desk.progress.olderSessions', `更早的会话 ${folded} 个 · 可在左侧搜索打开`, { count: folded })}</div>
      )}
    </div>
  );
}
