import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function read(path: string) {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('SessionMapView UX copy', () => {
  it('keeps current work primary and historical sessions secondary', () => {
    const source = read('desktop/src/react/components/desk/SessionMapView.tsx');
    expect(source).toContain('当前会话');
    expect(source).toContain('继续输入');
    expect(source).toContain('相关会话');
    expect(source).toContain('新建分支');
    expect(source).not.toContain('从此分支');
  });
});
