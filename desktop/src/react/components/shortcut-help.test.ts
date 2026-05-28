import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function read(path: string) {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('shortcut help modal', () => {
  it('wires Cmd+? to a discoverable shortcut and slash command reference', () => {
    const layout = read('desktop/src/react/components/SidebarLayout.tsx');
    const modal = read('desktop/src/react/components/ShortcutHelpModal.tsx');
    const styles = read('desktop/src/react/components/ShortcutHelpModal.module.css');
    expect(layout).toContain('ShortcutHelpModal');
    expect(layout).toContain("e.key === '?'");
    expect(layout).toContain("e.shiftKey && e.key === '/'");
    expect(modal).toContain('role="dialog"');
    expect(modal).toContain('aria-modal="true"');
    expect(modal).toContain("keys: ['Cmd/Ctrl', 'K']");
    expect(modal).toContain("keys: ['Cmd/Ctrl', 'Shift', 'N']");
    expect(modal).toContain('/goal');
    expect(modal).toContain('/compact');
    expect(styles).toContain('.overlay');
    expect(styles).toContain('z-index: 12000');
  });
});
