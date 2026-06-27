import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function read(path: string) {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('SessionMapView UX copy', () => {
  it('keeps current work primary and historical sessions secondary', () => {
    const source = read('desktop/src/react/components/desk/SessionMapView.tsx');
    const deskSection = read('desktop/src/react/components/DeskSection.tsx');
    expect(deskSection).toContain('会话进展');
    expect(deskSection).toContain('同步');
    expect(deskSection).toContain('进展');
    expect(deskSection).toContain('文件');
    expect(source).toContain('当前会话');
    expect(source).toContain('继续输入');
    expect(source).toContain('需要处理');
    expect(source).toContain('最近会话');
    expect(source).toContain('打开会话');
    expect(source).toContain('新建分支');
    expect(source).toContain('更早的会话');
    expect(source).not.toContain('从此分支');
    expect(source).not.toContain('暂无相关会话');
    expect(source).not.toContain('已收口');
  });
});
