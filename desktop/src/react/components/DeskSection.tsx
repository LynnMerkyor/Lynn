/**
 * DeskSection — 右侧会话进展 / 文件侧栏
 */

import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../stores';
import { ContextMenu } from './ContextMenu';
import { DESK_SORT_KEY, type SortMode, type CtxMenuState } from './desk/desk-types';
import { DeskWorkspaceButton, DeskBreadcrumb, DeskSortButton } from './desk/DeskToolbar';
import { DeskFileList } from './desk/DeskFileList';
import { DeskDropZone } from './desk/DeskDropZone';
import { DeskEmptyOverlay } from './desk/DeskEmptyOverlay';
import { GalleryPanel } from './desk/GalleryPanel';
import { GalleryToggleButton } from './desk/DeskToolbar';
import { SessionMapView } from './desk/SessionMapView';
import { loadDeskAutomationStatus, loadDeskPatrolStatus, triggerDeskHeartbeat } from '../stores/desk-actions';
import { loadSessions } from '../stores/session-actions';
import styles from './desk/Desk.module.css';

export function DeskSection() {
  const deskFiles = useStore(state => state.deskFiles);
  const deskBasePath = useStore(state => state.deskBasePath);
  const deskView = useStore(state => state.deskView);
  const setDeskView = useStore(state => state.setDeskView);
  const sessions = useStore(state => state.sessions);
  const patrolStatus = useStore(state => state.deskPatrolStatus);

  const serverPort = useStore(state => state.serverPort);
  const [patrolBusy, setPatrolBusy] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>(
    () => (localStorage.getItem(DESK_SORT_KEY) as SortMode) || 'mtime-desc',
  );
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);

  const handleShowMenu = useCallback((state: CtxMenuState) => {
    setCtxMenu(state);
  }, []);

  const handleCloseMenu = useCallback(() => {
    setCtxMenu(null);
  }, []);

  const deskGalleryOpen = useStore(state => state.deskGalleryOpen);
  const t = window.t ?? ((key: string) => key);
  const tt = useCallback((key: string, fallback: string) => {
    const value = t(key);
    return !value || value === key ? fallback : value;
  }, [t]);
  const hasWorkspace = !!deskBasePath;
  const showFileSurface = hasWorkspace && deskFiles.length > 0;
  useEffect(() => {
    if (!serverPort) return;
    void loadDeskPatrolStatus();
    void loadDeskAutomationStatus();
    void loadSessions();
  }, [serverPort]);

  useEffect(() => {
    if (patrolStatus?.state !== 'running') return undefined;
    const timer = window.setInterval(() => {
      void loadDeskPatrolStatus();
      void loadSessions();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [patrolStatus?.state]);

  const handleRunPatrol = useCallback(async () => {
    if (patrolBusy) return;
    setPatrolBusy(true);
    try {
      await triggerDeskHeartbeat();
      await loadSessions();
      window.setTimeout(() => { void loadSessions(); void loadDeskPatrolStatus(); }, 2500);
      window.setTimeout(() => { void loadSessions(); void loadDeskPatrolStatus(); }, 8000);
    } finally {
      setPatrolBusy(false);
    }
  }, [patrolBusy]);

  return (
    <>
      <DeskDropZone onShowMenu={handleShowMenu}>
        <div className={styles.workspaceRailHeader}>
          <div className={styles.workspaceRailTitleBlock}>
            <div className={styles.workspaceRailTitle}>{tt('desk.workspaceMap', '会话进展')}</div>
            <div className={styles.workspaceRailSubline}>
              {patrolStatus?.text || tt('desk.patrolIdle', '同步待命')}
            </div>
          </div>
          <button
            type="button"
            className={`${styles.workspaceRailAction}${patrolStatus?.state === 'running' || patrolBusy ? ` ${styles.workspaceRailActionRunning}` : ''}`}
            onClick={() => { void handleRunPatrol(); }}
            disabled={patrolStatus?.state === 'running' || patrolBusy}
          >
            {patrolStatus?.state === 'running' || patrolBusy ? tt('desk.patrolRunningShort', '同步中') : tt('desk.runPatrol', '同步')}
          </button>
        </div>
        <div className={styles.workspaceRailTabs}>
          <button
            type="button"
            className={`${styles.workspaceRailTab}${deskView === 'map' ? ` ${styles.workspaceRailTabActive}` : ''}`}
            onClick={() => setDeskView('map')}
          >
            {tt('desk.mapTab', '进展')}
          </button>
          <button
            type="button"
            className={`${styles.workspaceRailTab}${deskView === 'materials' ? ` ${styles.workspaceRailTabActive}` : ''}`}
            onClick={() => setDeskView('materials')}
          >
            {tt('desk.materialsTab', '文件')}
          </button>
        </div>
        {deskView === 'map' ? (
          <SessionMapView />
        ) : (
          <>
            <div className={styles.header}>
              <div className={`jian-section-title ${styles.sectionTitle}`}>{tt('desk.materialsTab', '文件')}</div>
            </div>
            <DeskWorkspaceButton />
            {showFileSurface && (
              <>
                <div className={styles.toolbar}>
                  <DeskBreadcrumb />
                  <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                    <GalleryToggleButton />
                    <DeskSortButton sortMode={sortMode} onSort={setSortMode} onShowMenu={handleShowMenu} />
                  </div>
                </div>
                <div className={styles.fileSection}>
                  <div className={styles.fileSectionHeader}>{t('desk.workspace') || t('input.workspace')}</div>
                  <DeskFileList sortMode={sortMode} onShowMenu={handleShowMenu} />
                </div>
                {deskGalleryOpen && <GalleryPanel />}
              </>
            )}
            <DeskEmptyOverlay />
          </>
        )}
      </DeskDropZone>
      {ctxMenu && (
        <ContextMenu
          items={ctxMenu.items}
          position={ctxMenu.position}
          onClose={handleCloseMenu}
        />
      )}
    </>
  );
}
