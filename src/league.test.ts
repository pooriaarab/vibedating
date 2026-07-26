import { describe, expect, it } from 'vitest';
import {
  BELOW_LEAGUE,
  DEMO_TOTAL_TOKENS,
  LEAGUES,
  league,
  leagueIndex,
  parseTokensEnv,
} from './index.js';

describe('league() boundaries', () => {
  it('treats anything under 1M as below-1M', () => {
    expect(league(0).name).toBe(BELOW_LEAGUE);
    expect(league(0).min).toBe(0);
    expect(league(999_999).name).toBe(BELOW_LEAGUE);
    expect(league(1).name).toBe(BELOW_LEAGUE);
  });

  it('1M: inclusive lower, exclusive-of-5M upper', () => {
    expect(league(1_000_000).name).toBe('1M');
    expect(league(1_000_000).min).toBe(1_000_000);
    expect(league(4_999_999).name).toBe('1M');
  });

  it('5M boundaries', () => {
    expect(league(5_000_000).name).toBe('5M');
    expect(league(5_000_000).min).toBe(5_000_000);
    expect(league(9_999_999).name).toBe('5M');
  });

  it('10M boundaries', () => {
    expect(league(10_000_000).name).toBe('10M');
    expect(league(99_999_999).name).toBe('10M');
  });

  it('100M boundaries', () => {
    expect(league(100_000_000).name).toBe('100M');
    expect(league(999_999_999).name).toBe('100M');
  });

  it('1B+ is open-ended at the top', () => {
    expect(league(1_000_000_000).name).toBe('1B+');
    expect(league(1_000_000_001).name).toBe('1B+');
    expect(league(Number.MAX_SAFE_INTEGER).name).toBe('1B+');
  });

  it('clamps negatives to below-1M (never throws, never a real league)', () => {
    expect(league(-5).name).toBe(BELOW_LEAGUE);
    expect(league(-1_000_000_000).name).toBe(BELOW_LEAGUE);
  });

  it('floors non-integers before bucketing', () => {
    expect(league(999_999.9).name).toBe(BELOW_LEAGUE);
    expect(league(1_000_000.1).name).toBe('1M');
    expect(league(4_999_999.999).name).toBe('1M');
  });

  it('every LEAGUES entry is reachable at its min', () => {
    for (const l of LEAGUES) {
      expect(league(l.min).name).toBe(l.name);
    }
  });

  it('is pure: same input → same output', () => {
    expect(league(42_000_000)).toEqual(league(42_000_000));
  });
});

describe('leagueIndex', () => {
  it('maps league names to their ascending position', () => {
    expect(leagueIndex('1M')).toBe(0);
    expect(leagueIndex('5M')).toBe(1);
    expect(leagueIndex('10M')).toBe(2);
    expect(leagueIndex('100M')).toBe(3);
    expect(leagueIndex('1B+')).toBe(4);
  });

  it('treats below-1M as the tier just below 1M (index -1)', () => {
    expect(leagueIndex(BELOW_LEAGUE)).toBe(-1);
  });
});

describe('parseTokensEnv', () => {
  it('accepts plain integers', () => {
    expect(parseTokensEnv('23400000')).toBe(23_400_000);
    expect(parseTokensEnv('0')).toBe(0);
  });

  it('accepts k/M/B suffixes (case-insensitive)', () => {
    expect(parseTokensEnv('12M')).toBe(12_000_000);
    expect(parseTokensEnv('1.2B')).toBe(1_200_000_000);
    expect(parseTokensEnv('500k')).toBe(500_000);
    expect(parseTokensEnv('500K')).toBe(500_000);
  });

  it('returns undefined for garbage / empty', () => {
    expect(parseTokensEnv(undefined)).toBeUndefined();
    expect(parseTokensEnv('')).toBeUndefined();
    expect(parseTokensEnv('  ')).toBeUndefined();
    expect(parseTokensEnv('lots')).toBeUndefined();
    expect(parseTokensEnv('-5')).toBeUndefined();
  });

  it('floors fractional results', () => {
    expect(parseTokensEnv('1.5M')).toBe(1_500_000);
    expect(parseTokensEnv('0.9M')).toBe(900_000);
  });
});

describe('demo default lands in a real league', () => {
  it('DEMO_TOTAL_TOKENS is in the 10M league (non-empty demo pool)', () => {
    expect(league(DEMO_TOTAL_TOKENS).name).toBe('10M');
  });
});
