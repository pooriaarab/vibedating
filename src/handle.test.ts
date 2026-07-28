import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  connectProfile,
  DEFAULT_HANDLE,
  loadHandle,
  loadProfile,
  MAX_HANDLE_LEN,
  normalizeHandle,
  resolveHandle,
  saveHandle,
  sameHandle,
} from './state.js';
import type { UsageSnapshot } from '@pooriaarab/vibe-core';

const SNAPSHOT: UsageSnapshot = {
  harness: 'claude-code',
  totalTokens: 23_400_000,
  verified: false,
  windowStart: '2026-01-01T00:00:00.000Z',
  windowEnd: '2026-02-01T00:00:00.000Z',
};

describe('normalizeHandle()', () => {
  it('canonicalizes to exactly one leading "@"', () => {
    expect(normalizeHandle('alice')).toBe('@alice');
    expect(normalizeHandle('@alice')).toBe('@alice');
    expect(normalizeHandle('@@alice')).toBe('@alice');
    expect(normalizeHandle('  @alice  ')).toBe('@alice'); // trimmed
  });

  it('accepts a single-char body and the max-length handle', () => {
    expect(normalizeHandle('a')).toBe('@a');
    const max = 'a'.repeat(MAX_HANDLE_LEN - 1); // '@' + (MAX-1) body = MAX total
    const normMax = normalizeHandle(max);
    expect(normMax).toBe('@' + max);
    expect(normMax?.length).toBe(MAX_HANDLE_LEN);
  });

  it('rejects empty / whitespace-only / bare "@"', () => {
    expect(normalizeHandle('')).toBeNull();
    expect(normalizeHandle('   ')).toBeNull();
    expect(normalizeHandle('@')).toBeNull();
    expect(normalizeHandle('@@@')).toBeNull();
  });

  it('rejects handles longer than the cap (canonical form)', () => {
    const tooLong = 'a'.repeat(MAX_HANDLE_LEN); // body alone already at the cap
    expect(normalizeHandle(tooLong)).toBeNull(); // '@'+body exceeds MAX
  });

  it('rejects whitespace or control characters anywhere in the body', () => {
    expect(normalizeHandle('al ice')).toBeNull();
    expect(normalizeHandle('al\tice')).toBeNull();
    expect(normalizeHandle('alice\x01')).toBeNull(); // trailing control char is NOT trimmed
    expect(normalizeHandle('ali\x00ce')).toBeNull();
    expect(normalizeHandle('ali\x7fce')).toBeNull(); // DEL
    expect(normalizeHandle('ali\x1fce')).toBeNull(); // unit separator
  });

  it('rejects non-string input', () => {
    expect(normalizeHandle(undefined as unknown as string)).toBeNull();
    expect(normalizeHandle(42 as unknown as string)).toBeNull();
  });
});

describe('sameHandle()', () => {
  it('treats a leading "@" as optional on both sides', () => {
    expect(sameHandle('alice', '@alice')).toBe(true);
    expect(sameHandle('@alice', 'alice')).toBe(true);
    expect(sameHandle('@@alice', 'alice')).toBe(true);
    expect(sameHandle('alice', 'bob')).toBe(false);
  });
});

describe('handle persistence (loadHandle / saveHandle)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'vibedating-handle-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loadHandle returns the default when nothing is persisted', () => {
    expect(loadHandle(dir)).toBe(DEFAULT_HANDLE);
  });

  it('saveHandle validates, persists to handle.json, and returns the canonical form', () => {
    const got = saveHandle('alice', dir);
    expect(got).toBe('@alice');
    const raw = JSON.parse(readFileSync(path.join(dir, 'handle.json'), 'utf8')) as {
      handle: string;
    };
    expect(raw.handle).toBe('@alice');
    expect(loadHandle(dir)).toBe('@alice');
  });

  it('saveHandle accepts an explicit "@" and stores the canonical form', () => {
    expect(saveHandle('@bob', dir)).toBe('@bob');
    expect(loadHandle(dir)).toBe('@bob');
  });

  it('saveHandle is idempotent and overwrites the prior handle', () => {
    saveHandle('alice', dir);
    saveHandle('bob', dir);
    expect(loadHandle(dir)).toBe('@bob');
  });

  it('saveHandle throws on an invalid handle and does not write', () => {
    expect(() => saveHandle('', dir)).toThrow(/invalid handle/i);
    expect(() => saveHandle('a b', dir)).toThrow(/invalid handle/i);
    expect(existsSync(path.join(dir, 'handle.json'))).toBe(false);
    expect(loadHandle(dir)).toBe(DEFAULT_HANDLE);
  });

  it('saveHandle mirrors the handle onto an existing profile (no reconnect needed)', () => {
    const profile = connectProfile(SNAPSHOT, '@oldie', dir);
    expect(profile.handle).toBe('@oldie');
    saveHandle('@newname', dir);
    const reloaded = loadProfile(dir);
    expect(reloaded?.handle).toBe('@newname');
  });

  it('saveHandle works before connect (no profile) and is picked up on connect', () => {
    saveHandle('preconnect', dir);
    expect(loadProfile(dir)).toBeNull();
    const profile = connectProfile(SNAPSHOT, resolveHandle(dir), dir);
    expect(profile.handle).toBe('@preconnect');
  });

  it('loadHandle falls back to default on a corrupt handle.json', () => {
    writeFileSync(path.join(dir, 'handle.json'), '{not json', 'utf8');
    expect(loadHandle(dir)).toBe(DEFAULT_HANDLE);
  });
});

describe('resolveHandle() — env override is a one-off', () => {
  let dir: string;
  const origEnv = process.env['VIBEDATING_HANDLE'];
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'vibedating-resolve-'));
    delete process.env['VIBEDATING_HANDLE'];
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (origEnv === undefined) delete process.env['VIBEDATING_HANDLE'];
    else process.env['VIBEDATING_HANDLE'] = origEnv;
  });

  it('returns the default when nothing is persisted and no env is set', () => {
    expect(resolveHandle(dir)).toBe(DEFAULT_HANDLE);
  });

  it('returns the persisted handle', () => {
    saveHandle('@persisted', dir);
    expect(resolveHandle(dir)).toBe('@persisted');
  });

  it('env VIBEDATING_HANDLE overrides the persisted handle for the call only', () => {
    saveHandle('@persisted', dir);
    process.env['VIBEDATING_HANDLE'] = '@temp';
    expect(resolveHandle(dir)).toBe('@temp');
    // …but the persisted handle is untouched.
    expect(loadHandle(dir)).toBe('@persisted');
  });

  it('env without a leading "@" is still canonicalized', () => {
    process.env['VIBEDATING_HANDLE'] = 'tempname';
    expect(resolveHandle(dir)).toBe('@tempname');
  });

  it('an invalid env value is ignored (falls through to persisted/default)', () => {
    saveHandle('@persisted', dir);
    process.env['VIBEDATING_HANDLE'] = 'has space';
    expect(resolveHandle(dir)).toBe('@persisted');
  });
});
