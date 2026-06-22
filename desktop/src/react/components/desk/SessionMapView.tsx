import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../stores';
import type { Session } from '../../types';
import { branchSession, switchSession } from '../../stores/session-actions';
import s from './Desk.module.css';

type MapNode = {
  session: Session;
  level: number;
  x: number;
  y: number;
  r: number;
  color: string;
};

type MapEdge = {
  from: MapNode;
  to: MapNode;
};

function shortTitle(session: Session): string {
  const raw = session.digest?.objective || session.title || session.firstMessage || 'Untitled';
  return raw.length > 42 ? raw.slice(0, 41).trimEnd() + '…' : raw;
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

function nodeColor(session: Session): string {
  if (session.health?.level === 'critical') return 'var(--danger, #d33)';
  if (session.health?.level === 'large') return 'var(--warning, #b7791f)';
  if (session.topology?.taskStatus === 'completed') return 'var(--success, #2f9e44)';
  if (session.topology?.taskStatus === 'paused') return 'var(--text-muted, #777)';
  if ((session.insights || []).some((item) => item.status === 'unread')) return 'var(--accent, #6c5ce7)';
  return 'rgba(var(--accent-rgb), 0.72)';
}

function nodeRadius(session: Session): number {
  if (session.health?.level === 'critical') return 18;
  if (session.health?.level === 'large') return 14;
  const count = Math.min(9, Math.max(0, Number(session.messageCount || 0)));
  return 8 + Math.min(5, Math.floor(count / 2));
}

function buildMap(sessions: Session[], currentPath: string | null): { nodes: MapNode[]; edges: MapEdge[]; width: number; height: number } {
  const visible = [...sessions]
    .sort((a, b) => {
      const ac = a.path === currentPath ? 1 : 0;
      const bc = b.path === currentPath ? 1 : 0;
      if (ac !== bc) return bc - ac;
      return String(b.modified || '').localeCompare(String(a.modified || ''));
    })
    .slice(0, 80);
  const byPath = new Map(visible.map((session) => [session.path, session]));
  const levelMemo = new Map<string, number>();
  const levelFor = (session: Session): number => {
    const cached = levelMemo.get(session.path);
    if (cached !== undefined) return cached;
    const parent = session.topology?.parentSessionPath || null;
    const parentSession = parent ? byPath.get(parent) : null;
    const level = parentSession ? Math.min(5, levelFor(parentSession) + 1) : 0;
    levelMemo.set(session.path, level);
    return level;
  };
  const buckets = new Map<number, Session[]>();
  for (const session of visible) {
    const level = levelFor(session);
    const list = buckets.get(level) || [];
    list.push(session);
    buckets.set(level, list);
  }
  const nodes: MapNode[] = [];
  const colGap = 112;
  const rowGap = 58;
  const marginX = 26;
  const marginY = 34;
  for (const [level, list] of [...buckets.entries()].sort(([a], [b]) => a - b)) {
    list.forEach((session, index) => {
      nodes.push({
        session,
        level,
        x: marginX + level * colGap,
        y: marginY + index * rowGap,
        r: nodeRadius(session),
        color: nodeColor(session),
      });
    });
  }
  const nodeByPath = new Map(nodes.map((node) => [node.session.path, node]));
  const edges = nodes
    .map((node) => {
      const parent = node.session.topology?.parentSessionPath || null;
      const from = parent ? nodeByPath.get(parent) : null;
      return from ? { from, to: node } : null;
    })
    .filter((edge): edge is MapEdge => !!edge);
  const width = Math.max(320, marginX * 2 + (Math.max(0, ...nodes.map((node) => node.level)) + 1) * colGap);
  const height = Math.max(260, marginY * 2 + Math.max(0, ...[...buckets.values()].map((list) => list.length)) * rowGap);
  return { nodes, edges, width, height };
}

export function SessionMapView() {
  const sessions = useStore((state) => state.sessions);
  const currentSessionPath = useStore((state) => state.currentSessionPath);
  const [selectedPath, setSelectedPath] = useState<string | null>(currentSessionPath);
  const map = useMemo(() => buildMap(sessions, currentSessionPath), [sessions, currentSessionPath]);
  const selected = sessions.find((session) => session.path === (selectedPath || currentSessionPath)) || sessions[0] || null;
  const hugeCount = sessions.filter((session) => session.health?.level === 'critical').length;
  const largeCount = sessions.filter((session) => session.health?.level === 'large').length;
  const unreadCount = sessions.reduce((sum, session) => sum + (session.insights || []).filter((item) => item.status === 'unread').length, 0);
  const t = window.t ?? ((key: string) => key);
  const tt = (key: string, fallback: string) => {
    const value = t(key);
    return !value || value === key ? fallback : value;
  };
  const unreadInsights = (selected?.insights || []).filter((item) => item.status === 'unread').slice(0, 2);

  useEffect(() => {
    if (currentSessionPath) setSelectedPath(currentSessionPath);
  }, [currentSessionPath]);

  return (
    <div className={s.sessionMap}>
      <div className={s.mapStats}>
        <div className={s.mapStat}>
          <strong>{sessions.length}</strong>
          <span>{tt('session.map.sessions', 'Sessions')}</span>
        </div>
        <div className={s.mapStat}>
          <strong>{hugeCount + largeCount}</strong>
          <span>{tt('session.map.large', 'Large/Huge')}</span>
        </div>
        <div className={s.mapStat}>
          <strong>{unreadCount}</strong>
          <span>{tt('session.map.insights', 'Insights')}</span>
        </div>
      </div>

      <div className={s.mapCanvasWrap}>
        {map.nodes.length === 0 ? (
          <div className={s.mapEmpty}>{tt('session.map.empty', '暂无会话')}</div>
        ) : (
          <svg className={s.mapCanvas} viewBox={`0 0 ${map.width} ${map.height}`} role="img" aria-label="Session map">
            {map.edges.map((edge) => (
              <line
                key={`${edge.from.session.path}->${edge.to.session.path}`}
                x1={edge.from.x}
                y1={edge.from.y}
                x2={edge.to.x}
                y2={edge.to.y}
                className={s.mapEdge}
              />
            ))}
            {map.nodes.map((node) => {
              const active = node.session.path === currentSessionPath;
              const selectedNode = node.session.path === selected?.path;
              return (
                <g
                  key={node.session.path}
                  className={s.mapNodeGroup}
                  onClick={() => setSelectedPath(node.session.path)}
                  onDoubleClick={() => { void switchSession(node.session.path); }}
                >
                  <circle
                    cx={node.x}
                    cy={node.y}
                    r={node.r + (selectedNode ? 3 : 0)}
                    fill={node.color}
                    className={active ? s.mapNodeActive : s.mapNode}
                  />
                  <text x={node.x + node.r + 8} y={node.y + 4} className={s.mapNodeLabel}>
                    {shortTitle(node.session)}
                  </text>
                </g>
              );
            })}
          </svg>
        )}
      </div>

      {selected && (
        <div className={s.mapDetail}>
          <div className={s.mapDetailHead}>
            <div className={s.mapDetailTitle}>{shortTitle(selected)}</div>
            <button type="button" className={s.mapActionBtn} onClick={() => { void switchSession(selected.path); }}>
              {tt('session.map.open', 'Open')}
            </button>
          </div>
          <div className={s.mapMetaLine}>
            {selected.topology?.branchLabel ? <span>Branch: {selected.topology.branchLabel}</span> : null}
            {selected.health?.level && selected.health.level !== 'ok' ? <span>{selected.health.level} {formatBytes(selected.health.sizeBytes)}</span> : null}
            {(selected.insights || []).filter((item) => item.status === 'unread').length ? <span>Unread insights</span> : null}
          </div>
          {selected.digest?.summary && (
            <p className={s.mapSummary}>{selected.digest.summary}</p>
          )}
          {selected.digest?.nextSteps?.length ? (
            <div className={s.mapNextSteps}>
              {selected.digest.nextSteps.slice(0, 3).map((item) => <span key={item}>{item}</span>)}
            </div>
          ) : null}
          {unreadInsights.length ? (
            <div className={s.mapInsights}>
              {unreadInsights.map((item) => <p key={item.id}>{item.content}</p>)}
            </div>
          ) : null}
          <div className={s.mapDetailActions}>
            <button type="button" className={s.mapGhostBtn} onClick={() => { void branchSession(selected.path); }}>
              {tt('session.branchContinue', 'Branch from here')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
