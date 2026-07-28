/**
 * vibedating — dating by token usage.
 *
 * v0 library surface: league bucketing, local usage reading, and in-league
 * matching against a seeded set of candidate profiles. Raw usage never leaves
 * the machine; only the league bucket is shared.
 *
 * Builds on `@pooriaarab/vibe-core` (UsageSnapshot / Harness / consent ledger).
 */
import type { Harness, UsageSnapshot } from '@pooriaarab/vibe-core';

/**
 * A usage league (volume bucket). `max` is inclusive; the top tier is open-ended
 * (Number.POSITIVE_INFINITY).
 */
export interface League {
  readonly name: string;
  readonly min: number;
  readonly max: number;
}

/**
 * The five real leagues, in ascending order. (Accounts below 1M are reported as
 * {@link BELOW_LEAGUE} — not a real league, but adjacent to the 1M tier.)
 */
export const LEAGUES: readonly League[] = [
  { name: '1M', min: 1_000_000, max: 4_999_999 },
  { name: '5M', min: 5_000_000, max: 9_999_999 },
  { name: '10M', min: 10_000_000, max: 99_999_999 },
  { name: '100M', min: 100_000_000, max: 999_999_999 },
  { name: '1B+', min: 1_000_000_000, max: Number.POSITIVE_INFINITY },
];

/** League name for accounts that haven't crossed the first threshold yet. */
export const BELOW_LEAGUE = 'below-1M';

/**
 * Bucket a lifetime token count into a league. Pure: same input → same output.
 *
 * Returns `{ name, min }`. For counts below 1M the name is {@link BELOW_LEAGUE}
 * with `min: 0`. Non-negative only; negatives are clamped to 0. Non-integers are
 * floored (so 999_999.9 → below-1M, 1_000_000.9 → 1M).
 */
export function league(totalTokens: number): { name: string; min: number } {
  const n = Math.max(0, Math.floor(totalTokens));
  for (const l of LEAGUES) {
    if (n >= l.min && n <= l.max) {
      return { name: l.name, min: l.min };
    }
  }
  return { name: BELOW_LEAGUE, min: 0 };
}

/** Index of a league name in {@link LEAGUES}; {@link BELOW_LEAGUE} → -1. */
export function leagueIndex(name: string): number {
  if (name === BELOW_LEAGUE) return -1;
  return LEAGUES.findIndex((l) => l.name === name);
}

/**
 * Every league name on the ladder: {@link BELOW_LEAGUE} first (it sits just
 * below the 1M tier), then each {@link LEAGUES} name in ascending order.
 * Pure; returns a fresh array each call.
 */
export function allLeagueNames(): string[] {
  return [BELOW_LEAGUE, ...LEAGUES.map((l) => l.name)];
}

/**
 * League names whose index is within ±`width` of `name`'s index on the ladder,
 * clamped to the array bounds. Ascending (index order), de-duplicated.
 *
 * Edge-case decisions:
 *   - **{@link BELOW_LEAGUE}** is treated as "index -1" — it sits just below the
 *     1M tier, so `width` extends ONLY upward into the ladder
 *     (`leaguesWithin('below-1M', 1) → ['below-1M', '1M']`). This mirrors the
 *     existing `matches()` rule that below-1M is adjacent only to 1M.
 *   - **Unknown league names** (not in {@link LEAGUES}, not {@link BELOW_LEAGUE})
 *     return `[]` — we can't place them on the ladder, so they have no
 *     neighborhood.
 *   - **Negative width** is clamped to 0 (self only); non-integer width is
 *     truncated.
 *   - **Width larger than the ladder** is clamped to the bounds (whole ladder).
 */
export function leaguesWithin(name: string, width: number): string[] {
  const w = Math.max(0, Math.trunc(width));
  if (name === BELOW_LEAGUE) {
    return [BELOW_LEAGUE, ...LEAGUES.slice(0, w).map((l) => l.name)];
  }
  const center = leagueIndex(name);
  if (center < 0) return []; // unknown league → no neighborhood
  const lo = Math.max(0, center - w);
  const hi = Math.min(LEAGUES.length - 1, center + w);
  const out: string[] = [];
  for (let i = lo; i <= hi; i++) out.push(LEAGUES[i]!.name);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Usage reading                                                              */
/* -------------------------------------------------------------------------- */

/** Env var that holds a self-reported total token count (e.g. `23400000`). */
export const TOKENS_ENV = 'VIBEDATING_TOKENS';

/**
 * Demo total used when there is no real read and no env value, so `connect` and
 * the local web app work out of the box. Lands in the 10M league.
 */
export const DEMO_TOTAL_TOKENS = 23_400_000;

const MS_PER_DAY = 86_400_000;

/**
 * v0 usage reader. Resolution order:
 *
 *   1. (future) read-only OAuth → `verified: true`. **NOT implemented in v0** —
 *      see {@link tryReadVerifiedUsage}. This arm is the deliberate seam.
 *   2. a self-reported value from the {@link TOKENS_ENV} env var → `verified: false`.
 *   3. the demo value {@link DEMO_TOTAL_TOKENS} → `verified: false`.
 *
 * The snapshot's `totalTokens` is the only thing that must never leave the
 * machine; everything downstream consumes only the league bucket.
 */
export async function readUsage(harness: Harness = 'claude-code'): Promise<UsageSnapshot> {
  // ── Seam: read-only OAuth (verified:true). Land here once a provider exposes a
  // read-only usage scope. Intentionally unimplemented in v0 so the rest of the
  // product builds against a stable UsageSnapshot today. ──────────────────────
  const verified = await tryReadVerifiedUsage(harness);
  if (verified) return verified;

  // ── Self-reported (verified:false): env var, else demo default. ────────────
  const injected = parseTokensEnv(process.env[TOKENS_ENV]);
  const totalTokens = injected ?? DEMO_TOTAL_TOKENS;
  const now = new Date();
  return {
    harness,
    totalTokens,
    verified: false,
    windowStart: new Date(now.getTime() - 30 * MS_PER_DAY).toISOString(),
    windowEnd: now.toISOString(),
  };
}

/**
 * Future home of read-only OAuth verification. Returns `null` in v0.
 *
 * Implementing this (reading a real, provider-attested usage scope) flips the
 * snapshot to `verified: true` and is what makes the league trustworthy. Kept as
 * an explicit, named seam rather than a TODO comment so the privacy contract is
 * visible at the call site.
 */
export async function tryReadVerifiedUsage(_harness: Harness): Promise<UsageSnapshot | null> {
  return null;
}

const TOKEN_MULT: Record<string, number> = {
  '': 1,
  k: 1e3,
  K: 1e3,
  m: 1e6,
  M: 1e6,
  b: 1e9,
  B: 1e9,
};

/**
 * Parse a self-reported token count: a plain integer (`23400000`), or a suffixed
 * value (`12M`, `1.2B`, `500k`, `500K`). Returns `undefined` for anything that is
 * not a non-negative finite number, so callers can fall through to a default.
 */
export function parseTokensEnv(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const match = /^([0-9]*\.?[0-9]+)\s*([kKmMbB]?)$/.exec(trimmed);
  if (!match) return undefined;
  const num = Number(match[1]);
  if (!Number.isFinite(num) || num < 0) return undefined;
  const mult = TOKEN_MULT[match[2] ?? ''] ?? 1;
  return Math.floor(num * mult);
}

/* -------------------------------------------------------------------------- */
/* Candidates + matching                                                      */
/* -------------------------------------------------------------------------- */

/** A seeded candidate profile for the local demo (no real directory in v0). */
export interface Candidate {
  readonly handle: string;
  readonly league: string;
  readonly bio: readonly string[];
}

/**
 * Seeded demo pool. In v0 there is no central directory — these profiles live
 * locally only. Handles are abstract (no real identities); bios are flavor.
 */
export const CANDIDATES: readonly Candidate[] = [
  {
    handle: '@merge_conflict_therapist',
    league: '10M',
    bio: ['Resolves conflicts for a living — code and otherwise.', 'Currently: 47 tabs open, 3 are Stack Overflow.'],
  },
  {
    handle: '@rebase_romantic',
    league: '5M',
    bio: ['Rewrites history for a living, git and otherwise.', 'Looking for someone who squashes commits and grudges.'],
  },
  {
    handle: '@0xInsomniac',
    league: '1B+',
    bio: ['Token count is classified. Ask my therapist.', 'Has never once respected a rate limit.'],
  },
  {
    handle: '@yolo_to_main',
    league: '1M',
    bio: ['No branches, no regrets, no CI.', 'A green checkmark is a state of mind.'],
  },
  {
    handle: '@async_awaits_you',
    league: '10M',
    bio: ['Promises kept, unlike my sleep schedule.', 'DMs are non-blocking. Replies eventually resolve.'],
  },
  {
    handle: '@nullish_and_void',
    league: '5M',
    bio: ['Coalescing since 2019.', 'My love language is optional chaining.'],
  },
  {
    handle: '@ctrl_z_daddy',
    league: '100M',
    bio: ['Undo is my safe word.', 'Refactors everything, including this bio, twice.'],
  },
  {
    handle: '@segfault_sonnet',
    league: '1M',
    bio: ['Writes poetry in stack traces.', 'Core dumped. Heart, mostly, open.'],
  },
  {
    handle: '@the_lint_whisperer',
    league: '10M',
    bio: ['Zero warnings, zero regrets, zero chill.', 'Will fix your semicolons without being asked.'],
  },
];

/**
 * Filter `candidates` to the same league as `myLeague` or an adjacent one.
 *
 * "Adjacent" = exactly one tier above or below in {@link LEAGUES}, which keeps
 * the top of the ladder (1B+) from being an empty pool and lets newcomers
 * (below-1M) still see the 1M tier. Unknown league names never match. Pure and
 * order-preserving.
 */
export function matches(
  myLeague: string,
  candidates: readonly Candidate[] = CANDIDATES,
): Candidate[] {
  const myIdx = leagueIndex(myLeague);
  return candidates.filter((c) => {
    const idx = leagueIndex(c.league);
    if (idx < 0) return false; // unknown league on the candidate side → never a match
    return Math.abs(idx - myIdx) <= 1;
  });
}

/* Re-export the vibe-core primitives this product is built on, for convenience. */
export { createConsentLedger } from '@pooriaarab/vibe-core';
export type { Harness, UsageSnapshot } from '@pooriaarab/vibe-core';

/* Live P2P matching (hyperswarm DHT). Consent-gated; raw usage never leaves. */
export {
  leagueTopic,
  LIVE_NOTICE,
  loadPeers,
  parseHandshake,
  recordPeer,
  serializeHandshake,
  startDiscovery,
  TOPIC_PREFIX,
} from './p2p.js';
export type { DiscoveryOptions, DiscoverySession, PeerHello, StoredPeer } from './p2p.js';
