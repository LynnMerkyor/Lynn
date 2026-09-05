import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { AutomationJobCard } from './AutomationJobCard';
import { CATEGORY_DEFS, TEMPLATES, type AutomationCategory, type TemplateDefinition } from './templates';
import type { CronJob, ModelOption } from './types';
import styles from '../AutomationPanel.module.css';

export function AutomationTemplateLibrary({
  jobs,
  availableModels,
  loading,
  loadError,
  selectedTemplateId,
  selectionVersion,
  editingJobId,
  defaultModelLabel,
  isZh,
  onRetry,
  onSelectTemplate,
  onToggleJob,
  onEditJob,
  onRemoveJob,
  onRunJobNow,
  editor,
}: {
  jobs: CronJob[];
  availableModels: ModelOption[];
  loading: boolean;
  loadError: string | null;
  selectedTemplateId: string | null;
  selectionVersion: number;
  editingJobId: string | null;
  defaultModelLabel: string;
  isZh: boolean;
  onRetry: () => void;
  onSelectTemplate: (template: TemplateDefinition) => void;
  onToggleJob: (id: string) => void;
  onEditJob: (job: CronJob) => void;
  onRemoveJob: (id: string) => void;
  onRunJobNow: (id: string) => void;
  editor: (rootRef: RefObject<HTMLDivElement | null>) => ReactNode;
}) {
  const [activeCategory, setActiveCategory] = useState<AutomationCategory>('reports');
  const [view, setView] = useState<'jobs' | 'templates'>('jobs');
  const currentView = view;
  useEffect(() => {
    if (editingJobId) setView('jobs');
    else if (selectedTemplateId) setView('templates');
  }, [selectedTemplateId, editingJobId, selectionVersion]);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const composerAutoScrollRef = useRef(false);
  const sectionRefs = useRef<Record<AutomationCategory, HTMLDivElement | null>>({
    reports: null,
    organize: null,
    followup: null,
  });
  const templateSections = useMemo(() => CATEGORY_DEFS.map((category) => ({
    ...category,
    templates: TEMPLATES.filter((template) => template.category === category.key),
  })), []);

  useEffect(() => {
    if (!selectedTemplateId && !editingJobId) return undefined;
    let releaseTimer: number | null = null;
    const frame = window.requestAnimationFrame(() => {
      const container = scrollContainerRef.current;
      const composer = composerRef.current;
      if (!container || !composer) return;
      const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      const top = container.scrollTop + composer.getBoundingClientRect().top - container.getBoundingClientRect().top - 12;
      composerAutoScrollRef.current = true;
      container.scrollTo({ top: Math.max(0, top), behavior: reduceMotion ? 'instant' : 'smooth' });
      releaseTimer = window.setTimeout(() => {
        composerAutoScrollRef.current = false;
      }, reduceMotion ? 0 : 500);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (releaseTimer !== null) window.clearTimeout(releaseTimer);
      composerAutoScrollRef.current = false;
    };
  }, [editingJobId, selectedTemplateId, selectionVersion, currentView]);

  const scrollToCategory = useCallback((category: AutomationCategory) => {
    setView('templates');
    composerAutoScrollRef.current = false;
    setActiveCategory(category);
    const container = scrollContainerRef.current;
    const section = sectionRefs.current[category];
    if (!container || !section) return;
    const top = container.scrollTop + section.getBoundingClientRect().top - container.getBoundingClientRect().top - 8;
    container.scrollTo({ top, behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }, []);

  const syncActiveCategoryFromScroll = useCallback(() => {
    if (selectedTemplateId || editingJobId || composerAutoScrollRef.current) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    const anchor = container.getBoundingClientRect().top + 24;
    let nextCategory: AutomationCategory = CATEGORY_DEFS[0]?.key || 'reports';
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const category of CATEGORY_DEFS) {
      const section = sectionRefs.current[category.key];
      if (!section) continue;
      const rect = section.getBoundingClientRect();
      if (rect.bottom < anchor) continue;
      const distance = Math.abs(rect.top - anchor);
      if (distance < bestDistance) {
        bestDistance = distance;
        nextCategory = category.key;
      }
    }
    setActiveCategory((current) => current === nextCategory ? current : nextCategory);
  }, [editingJobId, selectedTemplateId]);

  return (
    <div className={styles.automationDialogBody}>
      <aside className={styles.automationSidebar}>
        <button type="button" className={`${styles.automationCategoryBtn}${currentView === 'jobs' ? ` ${styles.automationCategoryBtnActive}` : ''}`} onClick={() => setView('jobs')} aria-pressed={currentView === 'jobs'}>{isZh ? '已创建任务' : 'Created tasks'} ({jobs.length})</button>
        <button type="button" className={`${styles.automationCategoryBtn}${currentView === 'templates' ? ` ${styles.automationCategoryBtnActive}` : ''}`} onClick={() => setView('templates')} aria-pressed={currentView === 'templates'}>{isZh ? '新建任务 / 模板' : 'New task / templates'}</button>
        {currentView === 'templates' && <>
        {CATEGORY_DEFS.map((category) => (
          <button
            key={category.key}
            type="button"
            className={`${styles.automationCategoryBtn}${activeCategory === category.key ? ` ${styles.automationCategoryBtnActive}` : ''}`}
            onClick={() => scrollToCategory(category.key)}
            aria-pressed={activeCategory === category.key}
          >
            {isZh ? category.zhLabel : category.enLabel}
          </button>
        ))}
        </>}
      </aside>

      <section ref={scrollContainerRef} className={styles.automationMain} onScroll={syncActiveCategoryFromScroll}>
        <div className={styles.automationScroll}>
          {loadError && (
            <div className={styles.automationPanelNotice}>
              <div>{loadError}</div>
              <button type="button" className={styles.automationLinkBtn} onClick={onRetry} style={{ marginTop: 10 }}>
                {isZh ? '重试' : 'Retry'}
              </button>
            </div>
          )}

          {currentView === 'jobs' && jobs.length === 0 && !loading && <div className={styles.automationPanelNotice}>{isZh ? '还没有自动任务。选择“新建任务 / 模板”开始。' : 'No tasks yet. Choose New task / templates to begin.'}</div>}
          {currentView === 'jobs' && jobs.length > 0 && (
            <div className={styles.automationSection}>
              <div className={styles.automationSectionHeader}>
                <div className={styles.automationSectionTitle}>{isZh ? '已创建任务' : 'Created tasks'}</div>
                <div className={styles.automationSectionMeta}>{jobs.length}</div>
              </div>
              <div className={styles.automationJobGrid}>
                {jobs.map((job) => (
                  <AutomationJobCard
                    key={job.id}
                    job={job}
                    modelOptions={availableModels}
                    isZh={isZh}
                    defaultModelLabel={defaultModelLabel}
                    onToggle={onToggleJob}
                    onEdit={onEditJob}
                    onRemove={onRemoveJob}
                    onRunNow={onRunJobNow}
                  />
                ))}
              </div>
            </div>
          )}

          {currentView === 'templates' && templateSections.map((category) => (
            <div
              key={category.key}
              id={`automation-section-${category.key}`}
              ref={(node) => { sectionRefs.current[category.key] = node; }}
              className={styles.automationSection}
            >
              <div className={styles.automationSectionHeader}>
                <div className={styles.automationSectionTitle}>{isZh ? category.zhLabel : category.enLabel}</div>
                <div className={styles.automationSectionMeta}>{category.templates.length}</div>
              </div>
              <div className={styles.automationTemplateGrid}>
                {category.templates.map((template) => {
                  const selected = selectedTemplateId === template.id;
                  return (
                    <button
                      key={template.id}
                      type="button"
                      className={`${styles.automationTemplateCard}${selected ? ` ${styles.automationTemplateCardActive}` : ''}`}
                      onClick={() => onSelectTemplate(template)}
                      aria-pressed={selected}
                    >
                      <div className={styles.automationTemplateIcon}>{template.icon}</div>
                      <div className={styles.automationTemplateBody}>
                        <div className={styles.automationTemplateTitle}>{isZh ? template.zhTitle : template.enTitle}</div>
                        <div className={styles.automationTemplateDesc}>{isZh ? template.zhDesc : template.enDesc}</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          {loading && <div className={styles.automationPanelNotice}>{isZh ? '正在读取自动任务…' : 'Loading scheduled tasks...'}</div>}
        </div>
        {((currentView === 'templates' && selectedTemplateId) || (currentView === 'jobs' && editingJobId)) && editor(composerRef)}
      </section>
    </div>
  );
}
