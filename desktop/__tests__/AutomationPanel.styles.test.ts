import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const cssPath = path.resolve(__dirname, '../src/react/components/AutomationPanel.module.css');
const componentPath = path.resolve(__dirname, '../src/react/components/AutomationPanel.tsx');
const dataHookPath = path.resolve(__dirname, '../src/react/components/automation/useAutomationData.ts');
const draftHookPath = path.resolve(__dirname, '../src/react/components/automation/useAutomationDraft.ts');
const templateLibraryPath = path.resolve(__dirname, '../src/react/components/automation/AutomationTemplateLibrary.tsx');
const editorPath = path.resolve(__dirname, '../src/react/components/automation/AutomationEditor.tsx');
const sharedCssPath = path.resolve(__dirname, '../src/react/components/FloatingPanels.module.css');
const css = fs.readFileSync(cssPath, 'utf8');
const component = fs.readFileSync(componentPath, 'utf8');
const dataHook = fs.readFileSync(dataHookPath, 'utf8');
const sharedCss = fs.readFileSync(sharedCssPath, 'utf8');
const automationCss = css;

describe('AutomationPanel dark-theme styles', () => {
  it('uses theme surfaces instead of hard-coded white backgrounds', () => {
    expect(automationCss).toContain('.automationOverlay');
    expect(automationCss).not.toMatch(/background(?:-color)?:\s*rgba\(255,\s*255,\s*255/i);
    expect(automationCss).not.toMatch(/background(?:-color)?:[^;]*\bwhite\b/i);
    expect(automationCss).toContain('background: var(--bg-card);');
    expect(automationCss).toContain('color: var(--text);');
  });

  it('keeps a single main scroll container', () => {
    const mainRule = automationCss.match(/\.automationMain\s*\{([\s\S]*?)\}/)?.[1] || '';
    const listRule = automationCss.match(/\.automationScroll\s*\{([\s\S]*?)\}/)?.[1] || '';
    const composerRule = automationCss.match(/\.automationComposer\s*\{([\s\S]*?)\}/)?.[1] || '';

    expect(mainRule).toContain('overflow-y: auto');
    expect(listRule).not.toMatch(/overflow(?:-y)?:\s*(auto|scroll)/);
    expect(composerRule).not.toMatch(/overflow(?:-y)?:\s*(auto|scroll)/);
  });

  it('defines readable placeholders and native select options', () => {
    expect(automationCss).toContain('.automationFieldTextarea::placeholder');
    expect(automationCss).toContain('color: var(--text-muted);');
    expect(automationCss).toContain('.automationFieldSelect option');
    expect(automationCss).toContain('background: var(--bg-card);');
  });

  it('uses the shared modal focus trap and restores focus on close', () => {
    expect(component).toContain("import { useDialogA11y } from '../hooks/use-dialog-a11y';");
    expect(component).toContain('useDialogA11y({ open: isOpen, onClose: close })');
    expect(component).toContain('ref={dialogRef}');
    expect(component).toContain('tabIndex={-1}');
  });

  it('does not hide scheduled tasks when only model options fail to load', () => {
    expect(dataHook).toContain('Promise.allSettled([');
    expect(dataHook).toContain("if (cronResult.status === 'rejected') throw cronResult.reason;");
    expect(dataHook).toContain("if (modelsResult.status === 'fulfilled')");
  });

  it('keeps automation styling outside the shared floating-panel bundle', () => {
    expect(sharedCss).not.toContain('.automationOverlay');
  });

  it('keeps the panel as a small coordinator around data, templates, and editor modules', () => {
    expect(component.split('\n').length).toBeLessThan(180);
    expect(component).toContain("import { useAutomationData } from './automation/useAutomationData';");
    expect(component).toContain("import { useAutomationDraft } from './automation/useAutomationDraft';");
    expect(component).toContain("import { AutomationTemplateLibrary } from './automation/AutomationTemplateLibrary';");
    expect(component).toContain("import { AutomationEditor } from './automation/AutomationEditor';");
    expect(fs.existsSync(draftHookPath)).toBe(true);
    expect(fs.existsSync(templateLibraryPath)).toBe(true);
    expect(fs.existsSync(editorPath)).toBe(true);
  });

  it('keeps the split stylesheets below their former monolith size', () => {
    expect(sharedCss.split('\n').length).toBeLessThan(1600);
    expect(automationCss.split('\n').length).toBeLessThan(800);
  });
});
