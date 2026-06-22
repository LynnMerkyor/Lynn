import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../stores';
import type { Session } from '../../types';
import { branchSession, switchSession } from '../../stores/session-actions';
import s from './Desk.module.css';

type MapNodeKind = 'current' | 'risk' | 'insight' | 'branch' | 'recent' | 'cluster';
type SessionNodeKind = Exclude<MapNodeKind, 'cluster'>;

type MapNode =
  | { kind: SessionNodeKind; session: Session; key: string }
  | { kind: 'cluster'; key: string; count: number; onClick?: () => void };

function isCluster(node: MapNode): node is { kind: 'cluster'; key: string; count: number; onClick?: () => void } {
  return node.kind === 'cluster';
}

function sessionTitle(session: Session): string {
  const raw = session.digest?.objective || session.title || session.firstMessage || '';
  const trimmed = raw.trim();
  if (!trimmed) return '未命名会话';
  return trimmed.length > 40 ? trimmed.slice(0, 39).trimEnd() + '…' : trimmed;
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
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHour = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin}分钟前`;
  if (diffHour < 24) return `${diffHour}小时前`;
  if (diffDay < 7) return `${diffDay}天前`;
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function nodeIcon(kind: MapNodeKind): string {
  switch (kind) {
    case 'current':
      return '●';
    case 'risk':
      return '▲';
    case 'insight':
      return '◆';
    case 'branch':
      return '◎';
    case 'recent':
      return '○';
    case 'cluster':
      return '⋯';
    default:
      return '○';
  }
}

function nodeClassForKind(kind: SessionNodeKind): string {
  switch (kind) {
    case 'current':
      return s.mapNodeCurrent;
    case 'risk':
      return s.mapNodeRisk;
    case 'insight':
      return s.mapNodeInsight;
    case 'branch':
      return s.mapNodeBranch;
    case 'recent':
      return s.mapNodeRecent;
    default:
      return s.mapNodeRecent;
  }
}

function healthText(session: Session): string {
  const level = session.health?.level;
  const size = formatBytes(session.health?.sizeBytes);
  if (level === 'critical') return size ? `超大风险 · ${size}` : '超大风险';
  if (level === 'large') return size ? `大会话 · ${size}` : '大会话';
  return '';
}

function unreadCount(session: Session): number {
  return (session.insights || []).filter((item) => item.status === 'unread').length;
}

function hasBranchRelation(session: Session, all: Session[]): boolean {
  if (session.topology?.parentSessionPath) return true;
  return all.some((other) => other.topology?.parentSessionPath === session.path);
}

const VISIBLE_LIMIT = 20;

function buildNodes(
  sessions: Session[],
  currentPath: string | null,
): { nodes: MapNode[]; remaining: number } {
  if (sessions.length === 0) return { nodes: [], remaining: 0 };

  const scored = sessions.map((session) => {
    let score = 0;
    const reasons: SessionNodeKind[] = [];
    const isCurrent = session.path === currentPath;
    if (isCurrent) {
      score += 1000;
      reasons.push('current');
    }
    if (session.health?.level === 'critical') {
      score += 300;
      reasons.push('risk');
    } else if (session.health?.level === 'large') {
      score += 150;
      reasons.push('risk');
    }
    const unread = unreadCount(session);
    if (unread > 0) {
      score += 200 + Math.min(50, unread * 10);
      reasons.push('insight');
    }
    if (hasBranchRelation(session, sessions)) {
      score += 80;
      reasons.push('branch');
    }
    const modifiedMs = new Date(session.modified || 0).getTime() || 0;
    const ageDays = (Date.now() - modifiedMs) / 86400000;
    if (ageDays < 1) score += 60;
    else if (ageDays < 3) score += 30;
    else if (ageDays < 7) score += 10;

    return { session, score, reasons, modifiedMs };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.modifiedMs - a.modifiedMs;
  });

  const visibleItems = scored.slice(0, VISIBLE_LIMIT);
  const remaining = Math.max(0, sessions.length - visibleItems.length);

  const nodes: MapNode[] = visibleItems.map(({ session, reasons }) => {
    const kind = reasons[0] || 'recent';
    return { kind, session, key: session.path };
  });

  if (remaining > 0) {
    nodes.push({ kind: 'cluster', key: '__cluster__', count: remaining });
  }

  return { nodes, remaining };
}

export function SessionMapView() {
  const sessions = useStore((state) => state.sessions);
  const currentSessionPath = useStore((state) => state.currentSessionPath);
  const [selectedPath, setSelectedPath] = useState<string | null>(currentSessionPath);
  const { nodes, remaining } = useMemo(
    () => buildNodes(sessions, currentSessionPath),
    [sessions, currentSessionPath],
  );
  const selected = sessions.find((session) => session.path === (selectedPath || currentSessionPath)) || null;
  const riskCount = sessions.filter((session) => session.health?.level === 'critical' || session.health?.level === 'large').length;
  const totalUnread = sessions.reduce((sum, session) => sum + unreadCount(session), 0);
  const t = window.t ?? ((key: string) => key);
  const tt = (key: string, fallback: string) => {
    const value = t(key);
    return !value || value === key ? fallback : value;
  };

  useEffect(() => {
    if (currentSessionPath) setSelectedPath(currentSessionPath);
  }, [currentSessionPath]);

  const statusSummary = useMemo(() => {
    if (sessions.length === 0) return tt('session.map.empty', '暂无会话');
    if (riskCount === 0 && totalUnread === 0) {
      return `当前无大会话风险，${sessions.length} 个会话运行平稳`;
    }
    const parts: string[] = [];
    if (riskCount > 0) parts.push(`${riskCount} 个会话体积偏大`);
    if (totalUnread > 0) parts.push(`${totalUnread} 条未读洞察`);
    return parts.join(' · ');
  }, [sessions.length, riskCount, totalUnread, tt]);

  const handleClusterClick = () => {
    // 聚合节点可选中但不展示详情操作；未来可展开为完整列表。
    setSelectedPath(null);
  };

  return (
    <div className={s.sessionMap}>
      <div className={s.mapStatusBar}>{statusSummary}</div>

      <div className={s.mapCanvasWrap}>
        {nodes.length === 0 ? (
          <div className={s.mapEmpty}>{tt('session.map.empty', '暂无会话')}</div>
        ) : (
          <ul className={s.mapNodeList} role="listbox" aria-label="会话工作地图">
            {nodes.map((node) => {
              if (isCluster(node)) {
                return (
                  <li
                    key={node.key}
                    className={`${s.mapNodeItem} ${s.mapNodeCluster}`}
                    onClick={handleClusterClick}
                    role="option"
                    aria-selected="false"
                  >
                    <span className={s.mapNodeBullet} aria-hidden="true">
                      {nodeIcon('cluster')}
                    </span>
                    <span className={s.mapNodeText}>
                      其余 {node.count} 个普通会话
                    </span>
                  </li>
                );
              }
              const { session, kind } = node;
              const active = session.path === currentSessionPath;
              const selectedNode = selected?.path === session.path;
              const hText = healthText(session);
              const uCount = unreadCount(session);
              const branchLabel = session.topology?.branchLabel;
              const metaParts: string[] = [];
              if (hText) metaParts.push(hText);
              if (uCount > 0) metaParts.push(`${uCount} 条新洞察`);
              if (branchLabel) metaParts.push(`分支：${branchLabel}`);
              if (metaParts.length === 0) metaParts.push(formatTimeLabel(session.modified));

              return (
                <li
                  key={session.path}
                  className={`${s.mapNodeItem} ${nodeClassForKind(kind)} ${selectedNode ? s.mapNodeSelected : ''} ${active ? s.mapNodeActive : ''}`}
                  onClick={() => setSelectedPath(session.path)}
                  onDoubleClick={() => { void switchSession(session.path); }}
                  role="option"
                  aria-selected={selectedNode}
                >
                  <span className={s.mapNodeBullet} aria-hidden="true">
                    {nodeIcon(kind)}
                  </span>
                  <span className={s.mapNodeBody}>
                    <span className={s.mapNodeTitle}>{sessionTitle(session)}</span>
                    <span className={s.mapNodeMeta}>{metaParts.filter(Boolean).join(' · ')}</span>
                  </span>
                  {active && <span className={s.mapNodeActiveBadge}>当前</span>}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {selected && (
        <div className={s.mapDetail}>
          <div className={s.mapDetailHead}>
            <div className={s.mapDetailTitle}>{sessionTitle(selected)}</div>
            <button
              type="button"
              className={s.mapActionBtn}
              onClick={() => { void switchSession(selected.path); }}
            >
              打开
            </button>
          </div>
          <div className={s.mapMetaLine}>
            {selected.topology?.branchLabel ? (
              <span>分支：{selected.topology.branchLabel}</span>
            ) : null}
            {selected.health?.level && selected.health.level !== 'ok' ? (
              <span>{healthText(selected)}</span>
            ) : null}
            {unreadCount(selected) > 0 ? <span>{unreadCount(selected)} 条新洞察</span> : null}
          </div>
          {selected.digest?.summary && (
            <p className={s.mapSummary}>{selected.digest.summary}</p>
          )}
          {selected.digest?.nextSteps?.length ? (
            <div className={s.mapNextSteps}>
              {selected.digest.nextSteps.slice(0, 3).map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
          ) : null}
          {unreadCount(selected) > 0 && (
            <div className={s.mapInsights}>
              {(selected.insights || []).filter((item) => item.status === 'unread').slice(0, 2).map((item) => (
                <p key={item.id}>{item.content}</p>
              ))}
            </div>
          )}
          <div className={s.mapDetailActions}>
            <button
              type="button"
              className={s.mapGhostBtn}
              onClick={() => { void branchSession(selected.path); }}
            >
              从此分支
            </button>
          </div>
        </div>
      )}

      {remaining > 0 && !selected && (
        <div className={s.mapDetailPlaceholder}>
          已聚合 {remaining} 个普通会话；选中上方节点可打开或分支。
        </div>
      )}
    </div>
  );
}
