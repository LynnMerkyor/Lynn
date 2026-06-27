import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../stores';
import type { Session } from '../../types';
import { branchSession, consumeInsights, switchSession } from '../../stores/session-actions';
import s from './Desk.module.css';

type WorkState = 'active' | 'blocked' | 'risk' | 'done';

const GROUP_LIMIT = 8;

function sessionTitle(session: Session, opts: { current?: boolean } = {}): string {
  const raw = session.digest?.objective || session.title || session.firstMessage || '';
  const trimmed = raw.trim();
  if (!trimmed) return opts.current ? '当前会话' : '未命名会话';
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

function formatTimeLabel(iso?: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHour = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin}分钟前`;
  if (diffHour < 24) return `${diffHour}小时前`;
  if (diffDay < 7) return `${diffDay}天前`;
  return `${date.getMonth() + 1}月${date.getDate()}日`;
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

const STATE_LABEL: Record<WorkState, string> = {
  active: '推进中',
  blocked: '阻塞',
  risk: '风险',
  done: '已收口',
};

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
  const sessions = useStore((state) => state.sessions);
  const currentSessionPath = useStore((state) => state.currentSessionPath);
  const requestInputFocus = useStore((state) => state.requestInputFocus);
  const [selectedPath, setSelectedPath] = useState<string | null>(currentSessionPath);

  useEffect(() => {
    if (currentSessionPath) setSelectedPath(currentSessionPath);
  }, [currentSessionPath]);

  const { groups, folded, counts, currentSession } = useMemo(() => {
    const current = sessions.find((sess) => sess.path === currentSessionPath) || null;
    const work = sessions.filter((sess) => isWorkNode(sess, sessions, currentSessionPath));
    const boardWork = work.filter((sess) => sess.path !== currentSessionPath);
    const buckets: Record<WorkState, Session[]> = { active: [], blocked: [], risk: [], done: [] };
    for (const sess of boardWork) buckets[deriveState(sess)].push(sess);
    const sorter = (a: Session, b: Session) => sortWork(a, b, currentSessionPath);
    const activeItems = buckets.active.sort(sorter);
    const stalledItems = [...buckets.risk, ...buckets.blocked].sort(sorter);
    const doneItems = buckets.done.sort(sorter);
    const groupDefs = [
      { label: '进行中', items: activeItems },
      { label: '阻塞 · 风险', items: stalledItems },
      { label: '已收口', items: doneItems },
    ].filter((g) => g.items.length > 0);
    return {
      groups: groupDefs,
      folded: sessions.length - work.length,
      currentSession: current,
      counts: {
        active: activeItems.length + (current ? 1 : 0),
        stalled: stalledItems.length,
        done: doneItems.length,
        unread: work.reduce((sum, sess) => sum + unreadCount(sess), 0),
        related: boardWork.length,
      },
    };
  }, [sessions, currentSessionPath]);

  const selected = sessions.find((sess) => sess.path === (selectedPath || currentSessionPath)) || null;
  const parentOf = (sess: Session): Session | null =>
    sess.topology?.parentSessionPath
      ? sessions.find((p) => p.path === sess.topology?.parentSessionPath) || null
      : null;

  const totalWork = counts.active + counts.stalled + counts.done;

  const pulse = totalWork === 0
    ? '还没有可跟进的会话'
    : [
        counts.active > 0 ? `${counts.active} 推进中` : '',
        counts.stalled > 0 ? `${counts.stalled} 阻塞/风险` : '',
        counts.done > 0 ? `${counts.done} 已收口` : '',
      ].filter(Boolean).join(' · ');

  const renderCard = (sess: Session) => {
    const state = deriveState(sess);
    const active = sess.path === currentSessionPath;
    const isSel = selected?.path === sess.path;
    const unread = unreadCount(sess);
    const parent = parentOf(sess);
    const next = nextLine(sess);
    const meta: string[] = [];
    if (parent) meta.push(`来自 ${sessionTitle(parent)}`);
    if (sess.topology?.branchLabel) meta.push(sess.topology.branchLabel);
    if (isRisk(sess) && sess.health?.sizeBytes) meta.push(formatBytes(sess.health.sizeBytes));
    if (sess.messageCount) meta.push(`${sess.messageCount} 消息`);
    const time = formatTimeLabel(sess.modified);
    if (time) meta.push(time);

    return (
      <div
        key={sess.path}
        className={`${s.mapCard} ${isSel ? s.mapCardSel : ''} ${active ? s.mapCardActive : ''}`}
        onClick={() => setSelectedPath(sess.path)}
        onDoubleClick={() => { void switchSession(sess.path); }}
        role="option"
        aria-selected={isSel}
      >
        <div className={s.mapCardHead}>
          <span className={`${s.mapDot} ${STATE_DOT[state]}`} aria-hidden="true" />
          <span className={s.mapCardTitle}>{sessionTitle(sess)}</span>
          {active && <span className={`${s.mapChip} ${s.mapChipCurrent}`}>当前</span>}
          <span className={`${s.mapChip} ${STATE_CHIP[state]}`}>{STATE_LABEL[state]}</span>
          {unread > 0 && <span className={s.mapCardIns} title={`${unread} 条未读洞察`}>{unread}</span>}
        </div>
        {next && (
          <div className={s.mapCardNext}>
            <span>下一步</span>
            {next}
          </div>
        )}
        {meta.length > 0 && <div className={s.mapCardMeta}>{meta.join(' · ')}</div>}
      </div>
    );
  };

  const renderCurrentCard = () => {
    if (!currentSession) return null;
    const state = deriveState(currentSession);
    const next = nextLine(currentSession);
    const unread = unreadCount(currentSession);
    const meta: string[] = [];
    if (currentSession.messageCount) meta.push(`${currentSession.messageCount} 条消息`);
    const time = formatTimeLabel(currentSession.modified);
    if (time) meta.push(time);
    if (unread > 0) meta.push(`${unread} 条洞察`);
    return (
      <div className={s.mapCurrentCard}>
        <div className={s.mapCurrentTop}>
          <div className={s.mapCurrentCopy}>
            <span className={s.mapCurrentKicker}>当前会话</span>
            <strong>{sessionTitle(currentSession, { current: true })}</strong>
          </div>
          <span className={`${s.mapChip} ${STATE_CHIP[state]}`}>{STATE_LABEL[state]}</span>
        </div>
        <div className={s.mapCurrentBody}>
          {next ? (
            <>
              <span>下一步</span>
              <p>{next}</p>
            </>
          ) : (
            <p>{meta.length > 0 ? meta.join(' · ') : '正在等待你的下一条输入'}</p>
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
            继续输入
          </button>
          <button type="button" className={s.mapGhostBtn} onClick={() => { void branchSession(currentSession.path); }}>
            新建分支
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
        {counts.related > 0 && <span>相关会话 {counts.related}</span>}
        {counts.unread > 0 && <span className={s.mapPulseInsight}>{counts.unread} 条洞察</span>}
      </div>

      <div className={s.mapCanvasWrap}>
        {groups.length === 0 ? (
          <div className={s.mapEmpty}>暂无相关会话</div>
        ) : (
          <div className={s.mapBoard} role="listbox" aria-label="会话工作地图">
            <div className={s.mapBoardTitle}>相关会话</div>
            {groups.map((group) => {
              const shown = group.items.slice(0, GROUP_LIMIT);
              const overflow = group.items.length - shown.length;
              return (
                <div key={group.label} className={s.mapGroup}>
                  <div className={s.mapGroupHead}>{group.label} · {group.items.length}</div>
                  {shown.map(renderCard)}
                  {overflow > 0 && <div className={s.mapGroupMore}>+{overflow} 更多</div>}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {selected && selected.path !== currentSessionPath && (
        <div className={s.mapDetail}>
          <div className={s.mapDetailHead}>
            <div className={s.mapDetailTitle}>{sessionTitle(selected)}</div>
            <button type="button" className={s.mapActionBtn} onClick={() => { void switchSession(selected.path); }}>
              切换
            </button>
          </div>
          <div className={s.mapMetaLine}>
            <span>{STATE_LABEL[deriveState(selected)]}</span>
            {parentOf(selected) && <span>来自 {sessionTitle(parentOf(selected) as Session)}</span>}
            {isRisk(selected) && selected.health?.sizeBytes ? <span>{formatBytes(selected.health.sizeBytes)}</span> : null}
            {unreadCount(selected) > 0 ? <span>{unreadCount(selected)} 条新洞察</span> : null}
          </div>
          {selected.digest?.summary && <p className={s.mapSummary}>{selected.digest.summary}</p>}
          {selected.digest?.nextSteps?.length ? (
            <div className={s.mapNextSteps}>
              {selected.digest.nextSteps.slice(0, 3).map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
          ) : null}
          {unreadCount(selected) > 0 && (
            <div className={s.mapInsights}>
              {(selected.insights || []).filter((item) => item.status === 'unread').slice(0, 3).map((item) => (
                <div key={item.id} className={s.mapInsightItem}>
                  <p title={item.source ? `来自 ${item.source}` : undefined}>{item.content}</p>
                  <div className={s.mapInsightActions}>
                    <button
                      type="button"
                      className={s.mapActionBtn}
                      onClick={() => {
                        void consumeInsights(selected.path, [item.id]);
                        useStore.setState({ composerText: item.content, welcomeVisible: false });
                        useStore.getState().requestInputFocus();
                      }}
                    >
                      应用
                    </button>
                    <button
                      type="button"
                      className={s.mapGhostBtn}
                      onClick={() => { void consumeInsights(selected.path, [item.id]); }}
                    >
                      忽略
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className={s.mapDetailActions}>
            <button type="button" className={s.mapGhostBtn} onClick={() => { void branchSession(selected.path); }}>
              新建分支
            </button>
          </div>
        </div>
      )}

      {folded > 0 && (
        <div className={s.mapFolded}>归档 · {folded} 个空 / 已归档会话(原始历史仍可查)</div>
      )}
    </div>
  );
}
