import { describe, expect, it } from 'vitest';
import { profilePassed, releaseEfficiencyPlan } from '../scripts/release-cli-efficiency.mjs';

describe('release efficiency profiles', () => {
  it('keeps the fast thresholds and does not impose them on high reasoning', () => {
    const plan = releaseEfficiencyPlan();
    expect(plan.map(profile => profile.id)).toEqual(['low-routes', 'low-efficiency', 'high-routes', 'high-efficiency']);
    expect(plan[0].args).toEqual(expect.arrayContaining(['--max-stepfun-p50-ttft-ms', '2500', '--max-stepfun-p50-wall-ms', '4000']));
    expect(plan[1].args).toEqual(expect.arrayContaining(['--max-p50-ttft-ms', '2500', '--max-p50-wall-ms', '4500']));
    for (const profile of plan) {
      expect(profile.args[profile.args.indexOf('--reasoning') + 1]).toBe(profile.reasoning);
      expect(profile.args).toContain(profile.id.endsWith('-routes') ? '--min-stepfun-success-rate' : '--min-success-rate');
      if (profile.reasoning === 'high') {
        expect(profile.args).toContain('660000');
        expect(profile.args.some(arg => /max.*p50/.test(arg))).toBe(false);
      }
    }
  });

  it.each(releaseEfficiencyPlan())('rejects incomplete or mislabeled results for $id', profile => {
    const key = profile.id.endsWith('-routes') ? 'stepfun' : 'results';
    const rows = Array.from({ length: 3 }, () => ({ reasoning: profile.reasoning, ok: true, success: true }));
    const report = { reasoning: profile.reasoning, gate: { pass: true }, [key]: rows };
    expect(profilePassed(profile, 0, report)).toBe(true);
    expect(profilePassed(profile, 1, report)).toBe(false);
    expect(profilePassed(profile, 0, null)).toBe(false);
    expect(profilePassed(profile, 0, { ...report, reasoning: 'unknown' })).toBe(false);
    expect(profilePassed(profile, 0, { ...report, gate: { pass: false } })).toBe(false);
    expect(profilePassed(profile, 0, { ...report, [key]: rows.slice(1) })).toBe(false);
    expect(profilePassed(profile, 0, { ...report, [key]: [{ ...rows[0], ok: false, success: false }, ...rows.slice(1)] })).toBe(false);
  });
});
