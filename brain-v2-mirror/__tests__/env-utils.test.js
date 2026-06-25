import { describe, expect, it } from 'vitest';
import { positiveEnvNumber } from '../env-utils.js';

describe('env utils', () => {
  it('accepts only positive finite numeric env values', () => {
    expect(positiveEnvNumber('TIMEOUT_MS', 30_000, { TIMEOUT_MS: '12000' })).toBe(12_000);
    expect(positiveEnvNumber('TIMEOUT_MS', 30_000, { TIMEOUT_MS: '30s' })).toBe(30_000);
    expect(positiveEnvNumber('TIMEOUT_MS', 30_000, { TIMEOUT_MS: '0' })).toBe(30_000);
    expect(positiveEnvNumber('TIMEOUT_MS', 30_000, { TIMEOUT_MS: '-1' })).toBe(30_000);
    expect(positiveEnvNumber('TIMEOUT_MS', 30_000, {})).toBe(30_000);
  });
});
