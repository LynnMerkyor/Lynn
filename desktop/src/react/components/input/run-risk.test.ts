import { describe, expect, it } from 'vitest';
import { buildRunCommandPrompt, deriveRunRisk, runRiskLabel } from './run-risk';

describe('run-risk helpers', () => {
  it('classifies shell commands before sending them to execution mode', () => {
    expect(deriveRunRisk('ls -la')).toBe('low');
    expect(deriveRunRisk('npm test')).toBe('medium');
    expect(deriveRunRisk('git push origin main')).toBe('high');
    expect(deriveRunRisk('sudo rm -rf /tmp/example')).toBe('high');
  });

  it('builds an execution prompt with cwd and trimmed command', () => {
    const prompt = buildRunCommandPrompt('  npm test  ', '/repo');
    expect(prompt).toContain('当前工作目录：/repo');
    expect(prompt).toContain('```sh\nnpm test\n```');
    expect(prompt).toContain('真实结果');
  });

  it('falls back to Chinese labels when translations are missing', () => {
    expect(runRiskLabel('low', () => '')).toBe('低风险');
    expect(runRiskLabel('medium', () => '')).toBe('中风险');
    expect(runRiskLabel('high', () => '')).toBe('高风险');
  });
});
