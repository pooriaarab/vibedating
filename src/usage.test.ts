/**
 * readUsage — backed by vibe-core's readHarnessUsage. The contract under test:
 * `verified` is true ONLY when the number was measured from the harness's own
 * local logs (source 'real'); self-report (env or explicit) and the demo
 * fallback are always unverified, and the demo arm keeps vibedating's own
 * DEMO_TOTAL_TOKENS (10M league) so out-of-the-box behavior is unchanged.
 *
 * Every test disables ambient env overrides (VIBEDATING_TOKENS stubbed to '',
 * `env: {}` for vibe-core's VIBE_TOKENS) so nothing depends on the host.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_TOTAL_TOKENS, league, readUsage } from './index.js';

/** One fake claude-code assistant-transcript line (shape readClaudeUsage sums). */
function transcriptLine(id: string, requestId: string, usage: Record<string, number>): string {
  return JSON.stringify({ type: 'assistant', requestId, message: { id, usage } });
}

describe('readUsage — provenance + verified flag', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'vibedating-usage-'));
    // Neutralize the self-report env vars: '' parses to "no override".
    vi.stubEnv('VIBEDATING_TOKENS', '');
    vi.stubEnv('VIBE_TOKENS', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('VIBEDATING_TOKENS env → self-report, verified false (suffix-friendly parse)', async () => {
    vi.stubEnv('VIBEDATING_TOKENS', '12M');
    const snap = await readUsage('claude-code', { env: {} });
    expect(snap.source).toBe('self-report');
    expect(snap.verified).toBe(false);
    expect(snap.totalTokens).toBe(12_000_000);
    expect(league(snap.totalTokens).name).toBe('10M');
  });

  it('explicit selfReportTokens wins over the env var', async () => {
    vi.stubEnv('VIBEDATING_TOKENS', '12M');
    const snap = await readUsage('claude-code', { selfReportTokens: 5_000_000, env: {} });
    expect(snap.source).toBe('self-report');
    expect(snap.verified).toBe(false);
    expect(snap.totalTokens).toBe(5_000_000);
  });

  it('self-report wins over a real local read (precedence 1)', async () => {
    vi.stubEnv('VIBEDATING_TOKENS', '1000');
    const projects = path.join(dir, 'projects', 'proj');
    mkdirSync(projects, { recursive: true });
    writeFileSync(
      path.join(projects, 'session.jsonl'),
      transcriptLine('m1', 'r1', { input_tokens: 9_000_000, output_tokens: 0 }) + '\n',
    );
    const snap = await readUsage('claude-code', { root: dir, env: {} });
    expect(snap.source).toBe('self-report');
    expect(snap.totalTokens).toBe(1_000);
    expect(snap.verified).toBe(false);
  });

  it('real local logs → source real, verified true, summed + deduped by vibe-core', async () => {
    const projects = path.join(dir, 'projects', 'proj');
    mkdirSync(projects, { recursive: true });
    const lines = [
      transcriptLine('m1', 'r1', { input_tokens: 1_000_000, output_tokens: 500_000, cache_read_input_tokens: 250_000 }),
      transcriptLine('m2', 'r2', { input_tokens: 2_000_000, output_tokens: 1_000_000 }),
      transcriptLine('m1', 'r1', { input_tokens: 1_000_000, output_tokens: 500_000, cache_read_input_tokens: 250_000 }), // duplicate append — deduped
    ];
    writeFileSync(path.join(projects, 'session.jsonl'), lines.join('\n') + '\n');
    const snap = await readUsage('claude-code', { root: dir, env: {} });
    expect(snap.source).toBe('real');
    expect(snap.verified).toBe(true);
    expect(snap.totalTokens).toBe(4_750_000);
    expect(league(snap.totalTokens).name).toBe('1M');
    expect(snap.detail).toContain('transcripts');
  });

  it('no override + no readable logs → demo fallback, verified false, vibedating demo total', async () => {
    // openclaw has no local usage store; the dispatcher falls through to demo.
    const snap = await readUsage('openclaw', { env: {} });
    expect(snap.source).toBe('demo');
    expect(snap.verified).toBe(false);
    expect(snap.totalTokens).toBe(DEMO_TOTAL_TOKENS); // 23.4M — NOT vibe-core's 25k placeholder
    expect(league(snap.totalTokens).name).toBe('10M'); // demo behavior unchanged
  });

  it('invariant: verified === (source === "real") across all three sources', async () => {
    vi.stubEnv('VIBEDATING_TOKENS', '500');
    const selfReport = await readUsage('claude-code', { env: {} });
    vi.stubEnv('VIBEDATING_TOKENS', '');
    const demo = await readUsage('openclaw', { env: {} });
    const projects = path.join(dir, 'projects', 'proj');
    mkdirSync(projects, { recursive: true });
    writeFileSync(
      path.join(projects, 's.jsonl'),
      transcriptLine('m1', 'r1', { input_tokens: 1 }) + '\n',
    );
    const real = await readUsage('claude-code', { root: dir, env: {} });
    for (const snap of [selfReport, demo, real]) {
      expect(snap.verified).toBe(snap.source === 'real');
    }
  });
});
