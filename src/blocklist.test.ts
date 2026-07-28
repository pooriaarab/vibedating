import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addBlock,
  isBlocked,
  loadBlocklist,
  removeBlock,
} from './state.js';

describe('blocklist — loadBlocklist()', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'vibedating-block-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns [] when nothing is persisted', () => {
    expect(loadBlocklist(dir)).toEqual([]);
  });

  it('returns [] on a corrupt blocklist.json', () => {
    writeFileSync(path.join(dir, 'blocklist.json'), '{not json', 'utf8');
    expect(loadBlocklist(dir)).toEqual([]);
  });

  it('drops non-string entries from a malformed file', () => {
    writeFileSync(
      path.join(dir, 'blocklist.json'),
      JSON.stringify({ blocked: ['@a', 7, null, '@b'] }),
      'utf8',
    );
    expect(loadBlocklist(dir)).toEqual(['@a', '@b']);
  });
});

describe('blocklist — addBlock()', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'vibedating-block-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('canonicalizes (leading "@" added) and persists', () => {
    const { blocked, changed } = addBlock('alice', dir);
    expect(changed).toBe(true);
    expect(blocked).toEqual(['@alice']);
    const raw = JSON.parse(readFileSync(path.join(dir, 'blocklist.json'), 'utf8')) as {
      blocked: string[];
    };
    expect(raw.blocked).toEqual(['@alice']);
    expect(loadBlocklist(dir)).toEqual(['@alice']);
  });

  it('accepts an explicit "@"', () => {
    expect(addBlock('@bob', dir).blocked).toEqual(['@bob']);
  });

  it('is idempotent (already-blocked → changed:false, list unchanged)', () => {
    addBlock('@alice', dir);
    const again = addBlock('alice', dir); // bare name, same peer
    expect(again.changed).toBe(false);
    expect(again.blocked).toEqual(['@alice']);
  });

  it('dedupes across "@" spellings (sameHandle)', () => {
    addBlock('@alice', dir);
    addBlock('alice', dir); // no dup
    addBlock('@@alice', dir); // no dup
    expect(loadBlocklist(dir)).toEqual(['@alice']);
  });

  it('accumulates distinct handles in insertion order', () => {
    addBlock('@alice', dir);
    addBlock('@bob', dir);
    addBlock('@carol', dir);
    expect(loadBlocklist(dir)).toEqual(['@alice', '@bob', '@carol']);
  });

  it('throws on an invalid handle and does not write', () => {
    expect(() => addBlock('', dir)).toThrow(/invalid handle/i);
    expect(() => addBlock('a b', dir)).toThrow(/invalid handle/i);
    expect(existsSync(path.join(dir, 'blocklist.json'))).toBe(false);
  });
});

describe('blocklist — removeBlock()', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'vibedating-block-'));
    addBlock('@alice', dir);
    addBlock('@bob', dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('removes the matching handle (any "@" spelling) and persists', () => {
    const { blocked, changed } = removeBlock('alice', dir); // bare name
    expect(changed).toBe(true);
    expect(blocked).toEqual(['@bob']);
    expect(loadBlocklist(dir)).toEqual(['@bob']);
  });

  it('is idempotent (not-blocked → changed:false)', () => {
    removeBlock('@alice', dir);
    const again = removeBlock('@alice', dir);
    expect(again.changed).toBe(false);
    expect(again.blocked).toEqual(['@bob']);
  });

  it('throws on an invalid handle', () => {
    expect(() => removeBlock('', dir)).toThrow(/invalid handle/i);
    // list untouched
    expect(loadBlocklist(dir)).toEqual(['@alice', '@bob']);
  });
});

describe('blocklist — isBlocked()', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'vibedating-block-'));
    addBlock('@alice', dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('matches the canonical handle', () => {
    expect(isBlocked('@alice', dir)).toBe(true);
  });

  it('matches with the leading "@" stripped on either side', () => {
    expect(isBlocked('alice', dir)).toBe(true);
    expect(isBlocked('@@alice', dir)).toBe(true);
  });

  it('is false for a handle that is not blocked', () => {
    expect(isBlocked('@bob', dir)).toBe(false);
    expect(isBlocked('bob', dir)).toBe(false);
  });

  it('is lenient: never throws, false for empty/garbage input', () => {
    expect(isBlocked('', dir)).toBe(false);
    expect(isBlocked('@', dir)).toBe(false);
    expect(isBlocked('   ', dir)).toBe(false);
  });

  it('is false when nothing is persisted', () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), 'vibedating-block-empty-'));
    try {
      expect(isBlocked('@anyone', empty)).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
