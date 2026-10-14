import { describe, expect, it } from 'vitest';
import { profilePassed, releaseEfficiencyPlan, validReleaseEfficiencyPlan } from '../scripts/release-cli-efficiency.mjs';

describe('release efficiency profiles', () => {
  it('validates the actual four-profile configuration used by the static release gate', () => {
    expect(validReleaseEfficiencyPlan(releaseEfficiencyPlan())).toBe(true);
    expect(validReleaseEfficiencyPlan(null)).toBe(false);
    expect(validReleaseEfficiencyPlan(releaseEfficiencyPlan().slice(1))).toBe(false);
  });

  it('rejects weakened thresholds, missing live mode, duplicate profiles and misleading labels', () => {
    const mutations = [
      plan => { plan[0].args[plan[0].args.indexOf('--max-stepfun-p50-ttft-ms') + 1] = '5000'; },
      plan => { plan[1].args[plan[1].args.indexOf('--min-success-rate') + 1] = '0.5'; },
      plan => { plan[1].args = plan[1].args.filter(arg => arg !== '--live'); },
      plan => { plan[2] = structuredClone(plan[0]); },
      plan => { plan[2].reasoning = 'low'; },
      plan => { plan[3].script = 'scripts/not-live.mjs'; },
      plan => { plan[3].args.push('--max-p50-ttft-ms', '2500'); },
      plan => { plan[0].args.push('--reasoning', 'low'); },
    ];
    for (const mutate of mutations) {
      const plan = releaseEfficiencyPlan();
      mutate(plan);
      expect(validReleaseEfficiencyPlan(plan)).toBe(false);
    }
  });
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
