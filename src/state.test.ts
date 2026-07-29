import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveHandle, loadHandle, connectProfile } from './state.js';

describe('state', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'vibedating-state-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('atomic write leaves no partial file', () => {
    // Just testing saveHandle which uses writeJsonAtomic
    saveHandle('@alice', tmpDir);
    const handleFile = path.join(tmpDir, 'handle.json');
    expect(existsSync(handleFile)).toBe(true);
    // There should be no .tmp files lingering
    expect(existsSync(handleFile + '.tmp')).toBe(false);
    expect(loadHandle(tmpDir)).toBe('@alice');
  });
});
