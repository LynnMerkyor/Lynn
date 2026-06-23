/**
 * WelcomeScreen — 欢迎页 React 组件
 *
 * Phase 6C: 替代 app-agents-shim.ts 中的 renderWelcomeAgentSelector / updateWelcomeForAgent
 * 以及 bridge.ts desk shim 中的 folder picker / memory toggle。
 * 通过 portal 渲染到 #welcome，从 Zustand 状态驱动。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../stores';
import { hanaUrl } from '../hooks/use-hana-fetch';
import { useI18n } from '../hooks/use-i18n';
import { loadDeskFiles } from '../stores/desk-actions';
import { clearChat } from '../stores/agent-actions';
import { sendPrompt } from '../stores/prompt-actions';
import { yuanFallbackAvatar } from '../utils/agent-helpers';
import { ProviderStatusBadge } from './ProviderStatusBadge';
import { toggleSidebar } from './SidebarLayout';
import styles from './Welcome.module.css';

/* eslint-disable @typescript-eslint/no-explicit-any -- store setState 回调 (s: any) */

let _avatarTs = Date.now();
export function refreshAvatarTs() { _avatarTs = Date.now(); }

type QuickActionBehavior = 'prompt' | 'at';

const DEFAULT_QUICK_PROMPT_KEYS = [
  'welcome.quickActions.askFolder',
  'welcome.quickActions.summarizeWork',
  'welcome.quickActions.planToday',
] as const;
const DEFAULT_QUICK_PROMPT_KEY_SET = new Set<string>(DEFAULT_QUICK_PROMPT_KEYS);

const DEFAULT_QUICK_ACTION_BEHAVIORS: Record<string, QuickActionBehavior> = {
  'welcome.quickActions.askFolder': 'prompt',
  'welcome.quickActions.summarizeWork': 'at',
  'welcome.quickActions.planToday': 'prompt',
};

const QUICK_ACTIONS_LS_KEY = 'lynn-welcome-quick-actions-v1';

interface PersistedQuickAction { key: string; behavior: QuickActionBehavior }

/**
 * Quick action customization scaffold: WelcomeScreen reads from localStorage
 * first, falls back to the canonical defaults. A future Settings editor
 * (P2-4 Settings half) can write into this slot — no further changes are
 * needed here for the read path.
 *
 * The default key list is exported so an external editor can use it as the
 * baseline when initialising the editor with the user's current selection.
 */
export function readQuickActionsConfig(): PersistedQuickAction[] {
  try {
    const raw = localStorage.getItem(QUICK_ACTIONS_LS_KEY);
    if (!raw) return null as unknown as PersistedQuickAction[];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null as unknown as PersistedQuickAction[];
    const sane = parsed
      .filter((item) => item && typeof item.key === 'string')
      .filter((item) => DEFAULT_QUICK_PROMPT_KEY_SET.has(String(item.key)))
      .map((item) => ({
        key: String(item.key),
        behavior: (item.behavior === 'at' ? 'at' : 'prompt') as QuickActionBehavior,
      }));
    return sane.length > 0 ? sane : (null as unknown as PersistedQuickAction[]);
  } catch {
    return null as unknown as PersistedQuickAction[];
  }
}

export function WelcomeScreen() {
  return <WelcomeInner />;
}

function isBundledLynnAvatarSrc(src: string | null | undefined): boolean {
  const value = String(src || '');
  return value.includes('assets/Lynn-512-opt.png') || value.includes('assets/Lynn.png');
}

function randomWelcome(agentName: string, yuan: string): string {
  const t = window.t ?? ((p: string) => p);
  const yuanMsgs = t(`yuan.welcome.${yuan}`);
  const msgs = Array.isArray(yuanMsgs) ? yuanMsgs : t('welcome.messages');
  if (!Array.isArray(msgs) || msgs.length === 0) return '';
  const raw = msgs[Math.floor(Math.random() * msgs.length)];
  return raw.replaceAll('{name}', agentName);
}

function WelcomeInner() {
  const { t, locale } = useI18n();
  const welcomeVisible = useStore(s => s.welcomeVisible);
  const agents = useStore(s => s.agents);
  const agentName = useStore(s => s.agentName);
  const agentAvatarUrl = useStore(s => s.agentAvatarUrl);
  const agentYuan = useStore(s => s.agentYuan);
  const currentAgentId = useStore(s => s.currentAgentId);
  const selectedAgentId = useStore(s => s.selectedAgentId);
  const memoryEnabled = useStore(s => s.memoryEnabled);
  const selectedFolder = useStore(s => s.selectedFolder);
  const cwdHistory = useStore(s => s.cwdHistory);
  const pendingNewSession = useStore(s => s.pendingNewSession);
  const automationCount = useStore(s => s.automationCount);
  const sessions = useStore(s => s.sessions);
  const daySummaryChips = useMemo<DaySummaryChip[]>(() => {
    const isZh = (locale || '').startsWith('zh');
    const items: DaySummaryChip[] = [];
    if (automationCount > 0) {
      items.push({
        kind: 'automation',
        count: automationCount,
        label: isZh ? '自动任务' : 'automations',
        action: 'automation',
      });
    }
    if (sessions.length > 0) {
      items.push({
        kind: 'sessions',
        count: sessions.length,
        label: isZh ? '对话' : 'chats',
        action: 'sessions',
      });
    }
    return items;
  }, [automationCount, sessions.length, locale]);

  const daySummaryEmptyHint = useMemo(() => {
    if (daySummaryChips.length > 0) return '';
    const isZh = (locale || '').startsWith('zh');
    return isZh ? '问点什么开始吧 ✿' : 'Ask me anything to get started ✿';
  }, [daySummaryChips.length, locale]);

  const displayAgent = useMemo(() => {
    const sel = selectedAgentId || currentAgentId;
    return agents.find(a => a.id === sel) || null;
  }, [agents, selectedAgentId, currentAgentId]);

  const displayName = displayAgent?.name || agentName;
  const displayYuan = displayAgent?.yuan || agentYuan;
  const [greeting, setGreeting] = useState('');
  const prevAgentRef = useRef<string | null>(null);

  useEffect(() => {
    const agentKey = displayAgent?.id || currentAgentId;
    if (welcomeVisible && (prevAgentRef.current !== agentKey || !greeting)) {
      setGreeting(randomWelcome(displayName, displayYuan));
      prevAgentRef.current = agentKey ?? null;
    }
  }, [welcomeVisible, displayAgent?.id, currentAgentId, displayName, displayYuan, greeting]);

  useEffect(() => {
    if (welcomeVisible) {
      setGreeting(randomWelcome(displayName, displayYuan));
    }
  }, [welcomeVisible, displayName, displayYuan]);

  if (!welcomeVisible) return null;

  return (
    <div className={styles.welcome}>
      <WelcomeAvatar
        agentId={displayAgent?.id || null}
        hasAvatar={displayAgent?.hasAvatar ?? false}
        agentAvatarUrl={agentAvatarUrl}
        yuan={displayYuan}
        name={displayName}
      />
      <p className={styles.welcomeText}>{greeting}</p>
      <DaySummaryChips chips={daySummaryChips} emptyHint={daySummaryEmptyHint} />
      <ProviderStatusBadge />
      <QuickActions displayName={displayName} selectedFolder={selectedFolder} />
      <FolderPicker
        selectedFolder={selectedFolder}
        cwdHistory={cwdHistory}
        pendingNewSession={pendingNewSession}
      />
      <MemoryToggle enabled={memoryEnabled} t={t} />
      <span className={styles.focusHint}>{t('welcome.focusHint')}</span>
    </div>
  );
}

type DaySummaryAction = 'automation' | 'sessions';
type DaySummaryKind = 'automation' | 'sessions';
interface DaySummaryChip {
  kind: DaySummaryKind;
  count: number;
  label: string;
  action: DaySummaryAction;
}

function ChipIcon({ kind }: { kind: DaySummaryKind }) {
  switch (kind) {
    case 'automation':
      return (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <polygon points="13 2 4 14 12 14 11 22 20 10 12 10 13 2" />
        </svg>
      );
    case 'sessions':
      return (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
        </svg>
      );
  }
}

function runDaySummaryAction(action: DaySummaryAction) {
  switch (action) {
    case 'automation':
      useStore.getState().setActivePanel('automation');
      return;
    case 'sessions':
      toggleSidebar(true);
      return;
  }
}

function DaySummaryChips({ chips, emptyHint }: { chips: DaySummaryChip[]; emptyHint: string }) {
  if (chips.length === 0) {
    if (!emptyHint) return null;
    return <p className={styles.welcomeDaySummaryEmpty}>{emptyHint}</p>;
  }
  return (
    <div className={styles.daySummaryChips} role="group" aria-label="day-summary">
      {chips.map((chip) => (
        <button
          key={chip.kind}
          type="button"
          className={`${styles.daySummaryChip} ${styles[`daySummaryChip_${chip.kind}`] ?? ''}`}
          onClick={() => runDaySummaryAction(chip.action)}
        >
          <span className={styles.daySummaryChipIcon}>
            <ChipIcon kind={chip.kind} />
          </span>
          <span className={styles.daySummaryChipCount}>{chip.count}</span>
          <span className={styles.daySummaryChipLabel}>{chip.label}</span>
        </button>
      ))}
    </div>
  );
}

function WelcomeAvatar({ agentId, hasAvatar, agentAvatarUrl, yuan, name }: {
  agentId: string | null;
  hasAvatar: boolean;
  agentAvatarUrl: string | null;
  yuan: string;
  name: string;
}) {
  const [src, setSrc] = useState(() => {
    if (agentId && hasAvatar) return hanaUrl(`/api/agents/${agentId}/avatar?t=${_avatarTs}`);
    return agentAvatarUrl || yuanFallbackAvatar(yuan);
  });

  useEffect(() => {
    if (agentId && hasAvatar) {
      setSrc(hanaUrl(`/api/agents/${agentId}/avatar?t=${_avatarTs}`));
    } else if (agentAvatarUrl) {
      setSrc(agentAvatarUrl);
    } else {
      setSrc(yuanFallbackAvatar(yuan));
    }
  }, [agentId, agentAvatarUrl, hasAvatar, yuan]);

  const handleError = useCallback(() => {
    setSrc(yuanFallbackAvatar(yuan));
  }, [yuan]);

  const isBundledLynnAvatar = isBundledLynnAvatarSrc(src);

  return (
    <span className={styles.welcomeAvatarShell}>
      <img
        className={`${styles.welcomeAvatar}${isBundledLynnAvatar ? ` ${styles.welcomeAvatarBundledLynn}` : ''}`}
        src={src}
        alt={name}
        draggable={false}
        onError={handleError}
      />
    </span>
  );
}

function QuickActions({ displayName, selectedFolder }: { displayName: string; selectedFolder: string | null }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<string | null>(null);

  const actions = useMemo(() => {
    const persisted = readQuickActionsConfig();
    const config = persisted && persisted.length > 0
      ? persisted
      : DEFAULT_QUICK_PROMPT_KEYS.map((key) => ({
          key: key as string,
          behavior: DEFAULT_QUICK_ACTION_BEHAVIORS[key],
        }));
    return config.map(({ key, behavior }) => ({
      key,
      behavior,
      label: t(`${key}.label`),
      prompt: t(`${key}.prompt`, { name: displayName, folder: selectedFolder || t('input.selectWorkspace') }),
    }));
  }, [displayName, selectedFolder, t]);

  const handleClick = useCallback(async (key: string, prompt: string) => {
    setBusy(key);
    try {
      await sendPrompt({ text: prompt, displayText: prompt });
    } finally {
      setBusy(null);
    }
  }, []);

  const handleTryAt = useCallback(() => {
    useStore.setState({
      welcomeVisible: false,
      composerText: '@',
    });
    useStore.getState().requestInputFocus();
  }, []);

  return (
    <div className={styles.quickActions}>
      {actions.map((action) => (
        <button
          key={action.key}
          className={styles.quickActionBtn}
          onClick={() => {
            if (action.behavior === 'at') {
              handleTryAt();
              return;
            }
            void handleClick(action.key, action.prompt);
          }}
          disabled={busy !== null}
        >
          <span className={styles.quickActionLabel}>{action.label}</span>
        </button>
      ))}
    </div>
  );
}

function FolderPicker({ selectedFolder, cwdHistory, pendingNewSession }: {
  selectedFolder: string | null;
  cwdHistory: string[];
  pendingNewSession: boolean;
}) {
  const { t } = useI18n();
  const [showHistory, setShowHistory] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showHistory) return;
    const close = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setShowHistory(false);
      }
    };
    const timer = setTimeout(() => document.addEventListener('click', close, true), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('click', close, true);
    };
  }, [showHistory]);

  const handleBrowse = useCallback(async () => {
    setShowHistory(false);
    const folder = await window.platform?.selectFolder?.();
    if (!folder) return;
    applyFolderAction(folder, pendingNewSession);
  }, [pendingNewSession]);

  const handleToggleHistory = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowHistory(prev => !prev);
  }, []);

  const handleSelectHistory = useCallback((folder: string) => {
    setShowHistory(false);
    applyFolderAction(folder, pendingNewSession);
  }, [pendingNewSession]);

  const folderName = selectedFolder ? selectedFolder.split('/').pop() || selectedFolder : null;
  const label = folderName
    ? `${t('input.workspace')}${folderName}`
    : t('input.selectWorkspace');

  const hasHistory = cwdHistory.length > 0;

  return (
    <div
      className={`${styles.folderSelectWrap}${showHistory ? ` ${styles.folderSelectWrapShowHistory}` : ''}`}
      ref={wrapRef}
    >
      <div className={styles.folderSplitBtn}>
        <button
          className={`${styles.folderSelectBtn}${selectedFolder ? ` ${styles.folderSelectBtnHasFolder}` : ''}`}
          onClick={handleBrowse}
          title={t('input.selectFolder')}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
          </svg>
          <span>{label}</span>
        </button>
        {hasHistory && (
          <button
            className={`${styles.folderDropdownToggle}${showHistory ? ` ${styles.folderDropdownToggleOpen}` : ''}`}
            onClick={handleToggleHistory}
            title={t('input.recentFolders') || 'Recent folders'}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </button>
        )}
      </div>
      {showHistory && (
        <FolderHistory
          cwdHistory={cwdHistory}
          selectedFolder={selectedFolder}
          onSelect={handleSelectHistory}
          onBrowse={handleBrowse}
        />
      )}
    </div>
  );
}

function FolderHistory({ cwdHistory, selectedFolder, onSelect, onBrowse }: {
  cwdHistory: string[];
  selectedFolder: string | null;
  onSelect: (folder: string) => void;
  onBrowse: () => void;
}) {
  return (
    <div className={styles.folderHistory}>
      {cwdHistory.map(p => {
        const name = p.split('/').pop() || p;
        const isActive = p === selectedFolder;
        return (
          <div
            key={p}
            className={`${styles.folderHistoryItem}${isActive ? ` ${styles.folderHistoryItemActive}` : ''}`}
            title={p}
            onClick={(e) => { e.stopPropagation(); onSelect(p); }}
          >
            <span className={styles.folderHistoryItemIcon}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
              </svg>
            </span>
            <span className={styles.folderHistoryItemName}>{name}</span>
          </div>
        );
      })}
      <div className={styles.folderHistoryDivider} />
      <div className={styles.folderHistoryBrowse} onClick={(e) => { e.stopPropagation(); onBrowse(); }}>
        <span className={styles.folderHistoryItemIcon}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
            <line x1="12" y1="11" x2="12" y2="17"></line>
            <line x1="9" y1="14" x2="15" y2="14"></line>
          </svg>
        </span>
        <span>{(window.t ?? ((p: string) => p))('input.selectFolder')}...</span>
      </div>
    </div>
  );
}

function applyFolderAction(folder: string, pendingNewSession: boolean): void {
  useStore.setState({ selectedFolder: folder });

  if (!pendingNewSession) {
    useStore.setState({
      currentSessionPath: null,
      pendingNewSession: true,
    });
    clearChat();
    useStore.getState().requestInputFocus();
  }

  loadDeskFiles('', folder);
}

function MemoryToggle({ enabled, t }: {
  enabled: boolean;
  t: (key: string) => string;
}) {
  const handleClick = useCallback(() => {
    useStore.setState((s: any) => ({ memoryEnabled: !s.memoryEnabled }));
  }, []);

  return (
    <button
      className={`${styles.memoryToggleBtn}${enabled ? ` ${styles.memoryToggleBtnActive}` : ''}`}
      onClick={handleClick}
    >
      <svg className={styles.memoryToggleIcon} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2 L22 12 L12 22 L2 12 Z" />
      </svg>
      <span>{t(enabled ? 'welcome.memoryOn' : 'welcome.memoryOff')}</span>
    </button>
  );
}
