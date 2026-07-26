import { describe, expect, it } from 'vitest';
import { BELOW_LEAGUE, CANDIDATES, matches, type Candidate } from './index.js';

const pool: Candidate[] = [
  { handle: '@a', league: '1M', bio: [] },
  { handle: '@b', league: '5M', bio: [] },
  { handle: '@c', league: '10M', bio: [] },
  { handle: '@d', league: '100M', bio: [] },
  { handle: '@e', league: '1B+', bio: [] },
];

describe('matches()', () => {
  it('10M matches same + adjacent (5M, 10M, 100M)', () => {
    const names = matches('10M', pool).map((c) => c.handle);
    expect([...names].sort()).toEqual(['@b', '@c', '@d']);
  });

  it('1M matches 1M + 5M (nothing below except below-1M adjacency)', () => {
    const names = matches('1M', pool).map((c) => c.handle);
    expect([...names].sort()).toEqual(['@a', '@b']);
  });

  it('1B+ bridges the thin top: matches 100M + 1B+', () => {
    const names = matches('1B+', pool).map((c) => c.handle);
    expect([...names].sort()).toEqual(['@d', '@e']);
  });

  it('below-1M is adjacent only to the 1M tier', () => {
    const names = matches(BELOW_LEAGUE, pool).map((c) => c.handle);
    expect(names).toEqual(['@a']);
  });

  it('excludes non-adjacent tiers', () => {
    const names = matches('1M', pool).map((c) => c.handle);
    expect(names).not.toContain('@c');
    expect(names).not.toContain('@d');
    expect(names).not.toContain('@e');
  });

  it('preserves candidate order', () => {
    const list = matches('10M', pool);
    expect(list).toEqual(pool.filter((c) => ['5M', '10M', '100M'].includes(c.league)));
  });

  it('defaults to the seeded CANDIDATES and returns only in-range leagues', () => {
    const list = matches('10M');
    expect(list.length).toBeGreaterThan(0);
    for (const c of list) {
      expect(['5M', '10M', '100M']).toContain(c.league);
    }
  });

  it('seeded pool yields the expected 10M demo matches', () => {
    // DEMO_TOTAL_TOKENS lands in 10M; adjacency = 5M, 10M, 100M.
    const handles = matches('10M').map((c) => c.handle);
    expect(handles).toContain('@merge_conflict_therapist'); // 10M
    expect(handles).toContain('@rebase_romantic'); // 5M
    expect(handles).toContain('@ctrl_z_daddy'); // 100M
    expect(handles).not.toContain('@0xInsomniac'); // 1B+, too far
  });

  it('returns an empty array for an empty pool', () => {
    expect(matches('10M', [])).toEqual([]);
  });
});
