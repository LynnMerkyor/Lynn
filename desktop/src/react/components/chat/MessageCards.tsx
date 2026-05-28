import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import { ImageBlock } from './ImageBlock';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useI18n } from '../../hooks/use-i18n';
import { useStore } from '../../stores';
import { openPreview } from '../../stores/artifact-actions';
import { openFilePreview, openSkillPreview } from '../../utils/file-preview';
import styles from './Chat.module.css';

const WritingDiffViewer = lazy(() => import('./WritingDiffViewer').then((m) => ({ default: m.WritingDiffViewer })));

const EXT_LABELS: Record<string, string> = {
  pdf: 'PDF', doc: 'Word', docx: 'Word', xls: 'Excel', xlsx: 'Excel',
  ppt: 'Presentation', pptx: 'Presentation', md: 'Markdown', txt: 'Text',
  html: 'HTML', htm: 'HTML', css: 'Stylesheet', json: 'JSON', yaml: 'YAML', yml: 'YAML',
};

function extLabel(ext: string): string {
  return EXT_LABELS[ext.toLowerCase()] || ext.toUpperCase();
}

export function FileOutputCard({
  filePath,
  label,
  ext,
  openLabel,
}: {
  filePath: string;
  label: string;
  ext: string;
  openLabel: string;
}) {
  const [mdHtml, setMdHtml] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [externalDiff, setExternalDiff] = useState<{
    diff: string; linesAdded: number; linesRemoved: number; rollbackId?: string;
  } | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const isMd = ext === 'md' || ext === 'markdown';
  const isProse = isMd || ext === 'txt';
  const isZh = String(document?.documentElement?.lang || '').startsWith('zh');

  useEffect(() => {
    if (!isMd) return;
    let cancelled = false;
    window.platform?.readFile?.(filePath)?.then((content: string | null) => {
      if (cancelled || !content) return;
      import('../../utils/markdown').then(({ renderMarkdown }) => {
        if (!cancelled) setMdHtml(renderMarkdown(content));
      });
    });
    return () => { cancelled = true; };
  }, [filePath, isMd]);

  const handleViewExternalDiff = useCallback(async (e: ReactMouseEvent) => {
    e.stopPropagation();
    if (diffLoading) return;
    if (externalDiff) {
      setExternalDiff(null);
      return;
    }
    setDiffLoading(true);
    setDiffError(null);
    try {
      const res = await hanaFetch('/api/fs/external-diff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath }),
      });
      const data = await res.json();
      if (!data.hasChanges) {
        setDiffError(data.message || (isZh ? '无外部修改' : 'No external changes'));
        return;
      }
      setExternalDiff({
        diff: data.diff,
        linesAdded: data.linesAdded,
        linesRemoved: data.linesRemoved,
        rollbackId: data.rollbackId,
      });
    } catch (err) {
      const raw = err instanceof Error ? err.message : '';
      setDiffError(raw.replace(/^hanaFetch\s+\S+:\s*/, '').trim() || (isZh ? '对比失败' : 'Diff failed'));
    } finally {
      setDiffLoading(false);
    }
  }, [diffLoading, externalDiff, filePath, isZh]);

  return (
    <div
      className={styles.fileOutputCard}
      style={isMd && mdHtml ? { flexDirection: 'column', alignItems: 'stretch', maxWidth: '100%' } : undefined}
    >
      <div className={styles.fileOutputHead}>
        <span className={styles.fileOutputBadge}>{extLabel(ext)}</span>
        <span className={styles.fileOutputLabel}>{label || filePath.split('/').pop() || filePath}</span>
        <div className={styles.fileOutputActions}>
          <button type="button" className={styles.fileOutputOpen} onClick={() => openFilePreview(filePath, label, ext)}>
            {openLabel}
          </button>
          {isProse && (
            <button
              type="button"
              className={styles.fileOutputOpen}
              onClick={handleViewExternalDiff}
              disabled={diffLoading}
              title={isZh ? '对比 Git HEAD 以查看外部工具（如 Claude Code / VSCode）的修改' : 'Compare with git HEAD to view external edits'}
            >
              {diffLoading
                ? (isZh ? '… 对比中' : '… Comparing')
                : externalDiff
                  ? (isZh ? '隐藏对比' : 'Hide diff')
                  : (isZh ? '对比外部修改' : 'External diff')}
            </button>
          )}
          {isMd && mdHtml && (
            <button
              type="button"
              className={styles.fileOutputToggle}
              onClick={(e) => { e.stopPropagation(); setCollapsed(c => !c); }}
              aria-label={collapsed ? 'Expand preview' : 'Collapse preview'}
            >
              {collapsed ? '▶' : '▼'}
            </button>
          )}
        </div>
      </div>
      <div className={styles.fileOutputPath}>{filePath}</div>
      {diffError && (
        <div style={{
          marginTop: 8, padding: '6px 10px', fontSize: '0.78rem',
          color: 'var(--text-muted)', background: 'var(--overlay-subtle, rgba(0,0,0,0.03))',
          borderRadius: 4,
        }}>{diffError}</div>
      )}
      {externalDiff && (
        <div style={{ marginTop: 8 }}>
          <Suspense fallback={null}>
            <WritingDiffViewer
              filePath={filePath}
              diff={externalDiff.diff}
              linesAdded={externalDiff.linesAdded}
              linesRemoved={externalDiff.linesRemoved}
              rollbackId={externalDiff.rollbackId}
            />
          </Suspense>
        </div>
      )}
      {isMd && mdHtml && !collapsed && (
        <div
          className="md-content"
          style={{
            marginTop: '8px',
            padding: '12px',
            background: 'var(--bg-card, var(--bg))',
            borderRadius: '6px',
            border: '1px solid var(--overlay-light, rgba(0,0,0,0.06))',
            fontSize: '0.88rem',
            lineHeight: '1.6',
            maxHeight: '400px',
            overflowY: 'auto',
            wordBreak: 'break-word',
          }}
          dangerouslySetInnerHTML={{ __html: mdHtml }}
        />
      )}
    </div>
  );
}

export function ArtifactCard({ title, artifactType, artifactId, content, language }: {
  title: string;
  artifactType: string;
  artifactId: string;
  content: string;
  language?: string;
}) {
  const t = window.t ?? ((p: string) => p);
  const handleOpenPreview = () => openPreview({ id: artifactId, type: artifactType as any, title, content, language });
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    handleOpenPreview();
  };

  return (
    <div
      className={styles.fileOutputCard}
      style={{ cursor: 'pointer' }}
      role="button"
      tabIndex={0}
      onClick={handleOpenPreview}
      onKeyDown={handleKeyDown}
    >
      <div className={styles.fileOutputHead}>
        <span className={styles.fileOutputBadge}>{artifactType.toUpperCase()}</span>
        <span className={styles.fileOutputLabel}>{title}</span>
        {artifactType === 'html' && (
          <div className={styles.fileOutputActions}>
            <button
              type="button"
              className={styles.fileOutputOpen}
              onClick={(e) => { e.stopPropagation(); window.platform?.openHtmlInBrowser?.(content, title); }}
            >
              {t('preview.openInBrowser')}
            </button>
            <button
              type="button"
              className={styles.fileOutputOpen}
              onClick={async (e) => {
                e.stopPropagation();
                if (!window.platform?.exportHtmlToPng) return;
                const result = await window.platform.exportHtmlToPng(content, title);
                if (!result?.filePath) return;
              }}
            >
              {t('preview.exportPng')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function BrowserScreenshot({ base64, mimeType }: { base64: string; mimeType: string }) {
  return <ImageBlock className={styles.browserShot} src={`data:${mimeType};base64,${base64}`} alt="Browser Screenshot" />;
}

export function SkillCard({ skillName, skillFilePath }: { skillName: string; skillFilePath: string }) {
  return (
    <button
      type="button"
      className={styles.fileOutputCard}
      onClick={() => openSkillPreview(skillName, skillFilePath)}
    >
      <div className={styles.fileOutputHead}>
        <span className={styles.fileOutputBadge}>SKILL</span>
        <span className={styles.fileOutputLabel}>{skillName}</span>
      </div>
      <div className={styles.fileOutputPath}>{skillFilePath}</div>
    </button>
  );
}

export function CronConfirmCard({ confirmId, jobData, status }: { confirmId?: string; jobData: any; status: string }) {
  const { t } = useI18n();
  const addToast = useStore((s) => s.addToast);
  const [submitting, setSubmitting] = useState(false);

  const sendDecision = useCallback(async (action: 'approved' | 'rejected') => {
    if (!confirmId || submitting) return;
    setSubmitting(true);
    try {
      await hanaFetch(`/api/cron/confirm/${confirmId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      addToast(action === 'approved' ? t('common.saved') : t('common.cancelled'), 'success');
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setSubmitting(false);
    }
  }, [addToast, confirmId, submitting, t]);

  return (
    <div className={styles.cronConfirmCard}>
      <div className={styles.cronConfirmTitle}>{jobData.label || t('cron.confirm.title')}</div>
      <div className={styles.cronConfirmMeta}>{jobData.schedule}</div>
      <div className={styles.cronConfirmPrompt}>{jobData.prompt}</div>
      {status === 'pending' && confirmId && (
        <div className={styles.cronConfirmActions}>
          <button type="button" onClick={() => sendDecision('rejected')} disabled={submitting}>{t('common.cancel')}</button>
          <button type="button" onClick={() => sendDecision('approved')} disabled={submitting}>{t('common.confirm')}</button>
        </div>
      )}
    </div>
  );
}
