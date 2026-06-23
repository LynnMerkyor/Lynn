/**
 * TutorialStep.tsx — Finish step for quick start / advanced setup
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { StepContainer, Multiline } from '../onboarding-ui';
import { useOnboardingI18n } from '../use-onboarding-i18n';

// ── SVG Icons ──

const MemoryIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v0m0 8c0-2 1.5-2.5 1.5-4.5a1.5 1.5 0 10-3 0C10.5 13.5 12 14 12 16z" />
  </svg>
);

const SkillsIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
  </svg>
);

const WorkspaceIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
  </svg>
);

const WorkMapIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="9" y1="13" x2="15" y2="13" />
    <line x1="9" y1="17" x2="13" y2="17" />
  </svg>
);

const PatrolIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3l7 4v5c0 5-3.5 7.7-7 9-3.5-1.3-7-4-7-9V7l7-4z" />
    <path d="M9.5 12l1.8 1.8L15 10.1" />
  </svg>
);

const ActivityIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="4" />
    <path d="M7 15l3-3 2 2 5-5" />
  </svg>
);

function TutorialCard({ icon, title, desc }: {
  icon: React.ReactNode;
  title: string;
  desc: string;
}) {
  return (
    <div className="tutorial-card">
      <div className="tutorial-card-header">
        <span className="tutorial-card-icon">{icon}</span>
        <span className="tutorial-card-title">{title}</span>
      </div>
      <Multiline className="tutorial-card-desc" text={desc} />
    </div>
  );
}

const PREVIEW_REPLY_ZH = '我看见你的消息了。我可以读写文件、跑命令、跟进工作地图，先告诉我你今天想做什么吧。';
const PREVIEW_REPLY_EN = "I see you — I can read/write files, run commands, and keep track of the work map. Tell me what you want to get done today.";

/**
 * StreamingPreview — animates a fake chat reply token-by-token so the user
 * can preview what streaming looks like without leaving onboarding (the
 * onboarding window has no chat WS).
 */
function StreamingPreview({ isZh }: { isZh: boolean }) {
  const [playing, setPlaying] = useState(false);
  const [text, setText] = useState('');
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);

  const start = useCallback(() => {
    if (playing) return;
    setPlaying(true);
    setText('');
    const full = isZh ? PREVIEW_REPLY_ZH : PREVIEW_REPLY_EN;
    let i = 0;
    timer.current = setInterval(() => {
      i += 1;
      setText(full.slice(0, i));
      if (i >= full.length) {
        if (timer.current) clearInterval(timer.current);
        timer.current = null;
        setPlaying(false);
      }
    }, isZh ? 60 : 32);
  }, [isZh, playing]);

  return (
    <div className="tutorial-preview-stream">
      <div className="tutorial-preview-bubble">
        {text || (isZh ? '点击下方按钮，看 Lynn 流式回复一段示例。' : 'Click the button below to play a streaming reply demo.')}
        {playing && <span className="tutorial-preview-caret" aria-hidden>▍</span>}
      </div>
      <button
        type="button"
        className="ob-btn ob-btn-secondary tutorial-preview-btn"
        onClick={start}
        disabled={playing}
      >
        {playing
          ? (isZh ? '正在播放预览…' : 'Playing preview…')
          : (isZh ? '试试看（仅预览）' : 'Try it (preview only)')}
      </button>
    </div>
  );
}

/**
 * FolderPickerStep — really triggers the folder picker IPC. Lets the user
 * pick their workspace ahead of entering the main window.
 */
function FolderPickerStep({ isZh, t }: { isZh: boolean; t: (key: string, vars?: Record<string, string | number>) => string }) {
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const onPick = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const folder = await window.platform?.selectFolder?.();
      if (folder) setPicked(folder);
    } finally {
      setBusy(false);
    }
  }, [busy]);
  return (
    <div className="tutorial-preview-folder">
      <button
        type="button"
        className="ob-btn ob-btn-secondary tutorial-preview-btn"
        onClick={() => void onPick()}
        disabled={busy}
      >
        {isZh ? '立即选文件夹' : 'Pick folder now'}
      </button>
      {picked && (
        <div className="tutorial-preview-picked">{t('onboarding.tutorial.interactive.step2Selected', { folder: picked })}</div>
      )}
    </div>
  );
}

function InteractiveTutorial({ isZh, t }: { isZh: boolean; t: (key: string, vars?: Record<string, string | number>) => string }) {
  return (
    <div className="tutorial-interactive">
      <div className="tutorial-interactive-block">
        <div className="tutorial-interactive-title">{t('onboarding.tutorial.interactive.step1Title')}</div>
        <Multiline className="tutorial-interactive-desc" text={t('onboarding.tutorial.interactive.step1Desc')} />
        <StreamingPreview isZh={isZh} />
      </div>
      <div className="tutorial-interactive-block">
        <div className="tutorial-interactive-title">{t('onboarding.tutorial.interactive.step2Title')}</div>
        <Multiline className="tutorial-interactive-desc" text={t('onboarding.tutorial.interactive.step2Desc')} />
        <FolderPickerStep isZh={isZh} t={t} />
      </div>
      <div className="tutorial-interactive-block">
        <div className="tutorial-interactive-title">{t('onboarding.tutorial.interactive.step3Title')}</div>
        <Multiline className="tutorial-interactive-desc" text={t('onboarding.tutorial.interactive.step3Desc')} />
        <div className="tutorial-preview-sidebar-mock">
          <div className="tutorial-preview-sidebar-row is-active">{isZh ? '工作地图' : 'Work map'}</div>
          <div className="tutorial-preview-sidebar-row">{isZh ? '自动任务' : 'Automations'}</div>
          <div className="tutorial-preview-sidebar-row">{isZh ? '与 Lynn 的对话' : 'Chat with Lynn'}</div>
        </div>
      </div>
    </div>
  );
}

type OnboardingTrack = 'quick' | 'quick-local' | 'advanced';

interface TutorialStepProps {
  preview: boolean;
  showError: (msg: string) => void;
  track: OnboardingTrack;
}

export function TutorialStep({ preview, showError, track }: TutorialStepProps) {
  const { t, locale } = useOnboardingI18n();
  const [finishing, setFinishing] = useState(false);
  const isQuickTrack = track === 'quick' || track === 'quick-local';
  const isZh = (locale || '').startsWith('zh');

  const onFinish = useCallback(async () => {
    if (preview) { window.close(); return; }
    setFinishing(true);
    try {
      const ok = await window.hana.onboardingComplete?.();
      if (ok === false) {
        showError(t('onboarding.error'));
        setFinishing(false);
      }
    } catch (err) {
      console.error('[onboarding] complete failed:', err);
      showError(t('onboarding.error'));
      setFinishing(false);
    }
  }, [preview, showError, t]);

  return (
    <StepContainer className="onboarding-step-tutorial">
      <h1 className="onboarding-title">{t(isQuickTrack ? 'onboarding.tutorial.quickTitle' : 'onboarding.tutorial.title')}</h1>
      {isQuickTrack && (
        <div className="ob-step-banner">
          <div className="ob-step-banner-title">{t('onboarding.tutorial.quickBannerTitle')}</div>
          <Multiline className="ob-step-banner-desc" text={t('onboarding.tutorial.quickBannerDesc')} />
        </div>
      )}

      <InteractiveTutorial isZh={isZh} t={t} />

      <div className="tutorial-cards">
        <TutorialCard
          icon={<WorkspaceIcon />}
          title={t('onboarding.tutorial.workspace.title')}
          desc={t('onboarding.tutorial.workspace.desc')}
        />
        <TutorialCard
          icon={<WorkMapIcon />}
          title={t('onboarding.tutorial.jian.title')}
          desc={t('onboarding.tutorial.jian.desc')}
        />
        <TutorialCard
          icon={<PatrolIcon />}
          title={t('onboarding.tutorial.patrol.title')}
          desc={t('onboarding.tutorial.patrol.desc')}
        />
        <TutorialCard
          icon={<MemoryIcon />}
          title={t('onboarding.tutorial.memory.title')}
          desc={t('onboarding.tutorial.memory.desc')}
        />
        <TutorialCard
          icon={<ActivityIcon />}
          title={t('onboarding.tutorial.activity.title')}
          desc={t('onboarding.tutorial.activity.desc')}
        />
        <TutorialCard
          icon={<SkillsIcon />}
          title={t('onboarding.tutorial.skills.title')}
          desc={t('onboarding.tutorial.skills.desc')}
        />
      </div>

      <div className="onboarding-actions onboarding-actions-finish">
        <button className="ob-finish-btn" disabled={finishing} onClick={onFinish}>
          {t(isQuickTrack ? 'onboarding.tutorial.quickFinish' : 'onboarding.tutorial.finish')}
        </button>
      </div>
    </StepContainer>
  );
}
