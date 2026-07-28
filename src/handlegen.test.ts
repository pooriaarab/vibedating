import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureHandle, generateHandle } from './handlegen.js';
import { DEFAULT_HANDLE, MAX_HANDLE_LEN, loadHandle, normalizeHandle, saveHandle } from './state.js';

/** Seeded PRNG (mulberry32) — deterministic generation for tests. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

describe('generateHandle()', () => {
  it('always produces a handle that passes normalizeHandle', () => {
    const rand = mulberry32(1337);
    for (let i = 0; i < 500; i++) {
      const h = generateHandle(rand);
      expect(normalizeHandle(h)).toBe(h);
      expect(h.startsWith('@')).toBe(true);
      expect(h.length).toBeLessThanOrEqual(MAX_HANDLE_LEN);
      expect(/^@[a-z0-9_]+$/.test(h)).toBe(true);
    }
  });

  it('is deterministic for a seeded rng', () => {
    const a = generateHandle(mulberry32(42));
    const b = generateHandle(mulberry32(42));
    expect(a).toBe(b);
  });

  it('mints distinct handles across draws (memetic variety, no @you)', () => {
    const rand = mulberry32(2026);
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(generateHandle(rand));
    // Birthday collisions are possible in a ~25k-name space; near-total
    // distinctness over 200 draws proves the lists actually vary.
    expect(seen.size).toBeGreaterThanOrEqual(190);
    expect(seen.has(DEFAULT_HANDLE)).toBe(false);
  });

  it('matches the memetic shape word_word(_suffix)', () => {
    const rand = mulberry32(7);
    for (let i = 0; i < 50; i++) {
      expect(generateHandle(rand)).toMatch(/^@[a-z0-9]+_[a-z0-9]+(_[a-z0-9]+)?$/);
    }
  });
});

describe('ensureHandle()', () => {
  let dir: string;
  const origEnv = process.env['VIBEDATING_HANDLE'];
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'vibedating-handlegen-'));
    delete process.env['VIBEDATING_HANDLE'];
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (origEnv === undefined) delete process.env['VIBEDATING_HANDLE'];
    else process.env['VIBEDATING_HANDLE'] = origEnv;
  });

  it('generates + persists a handle when none is set (never @you)', () => {
    const got = ensureHandle(dir);
    expect(got.generated).toBe(true);
    expect(got.handle).not.toBe(DEFAULT_HANDLE);
    expect(normalizeHandle(got.handle)).toBe(got.handle);
    // Persisted to handle.json — survives a reload.
    expect(loadHandle(dir)).toBe(got.handle);
    const raw = JSON.parse(readFileSync(path.join(dir, 'handle.json'), 'utf8')) as {
      handle: string;
    };
    expect(raw.handle).toBe(got.handle);
  });

  it('reuses the persisted handle on the next call (generates exactly once)', () => {
    const first = ensureHandle(dir);
    const second = ensureHandle(dir);
    expect(first.generated).toBe(true);
    expect(second).toEqual({ handle: first.handle, generated: false });
  });

  it('respects a user-set handle and never regenerates over it', () => {
    saveHandle('@custom', dir);
    const got = ensureHandle(dir);
    expect(got).toEqual({ handle: '@custom', generated: false });
  });

  it('VIBEDATING_HANDLE wins as a one-off and is NOT persisted', () => {
    process.env['VIBEDATING_HANDLE'] = 'envname';
    const got = ensureHandle(dir);
    expect(got).toEqual({ handle: '@envname', generated: false });
    expect(loadHandle(dir)).toBe(DEFAULT_HANDLE); // nothing written
  });

  it('an invalid env value falls through to generate+persist', () => {
    process.env['VIBEDATING_HANDLE'] = 'has space';
    const got = ensureHandle(dir);
    expect(got.generated).toBe(true);
    expect(loadHandle(dir)).toBe(got.handle);
  });
});
