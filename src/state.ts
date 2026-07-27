/**
 * Local profile state — the only thing persisted on disk.
 *
 * The league bucket is "shared" (with the local demo pool); the raw `totalTokens`
 * is stored only so the local web app can show it to the user behind an opt-in
 * toggle. It NEVER leaves this machine in v0 (no central directory).
 *
 * Consent for sharing the league is modeled with vibe-core's `createConsentLedger`
 * (scope {@link CONSENT_SCOPE}); it is granted on `connect` and revocable on
 * reset. Backed by a tiny JSON file next to the profile so it survives restarts.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConsentLedger } from '@pooriaarab/vibe-core';
import type { ConsentGrant, ConsentLedger, ConsentStore, UsageSnapshot } from '@pooriaarab/vibe-core';
import { league } from './index.js';

/** Consent scope covering "share my league bucket". Raw usage is never in scope. */
export const CONSENT_SCOPE = 'share:league';

/**
 * Consent scope covering live P2P discovery: joining the public DHT on your
 * league topic and exchanging { handle, league, harness } with same-league
 * peers. Raw usage is never in scope. Opt-in only (default OFF) — granted by
 * `vibedating discover --live`, never implicitly.
 */
export const LIVE_CONSENT_SCOPE = 'share:live';

/** The persisted profile. `totalTokens` is LOCAL ONLY. */
export interface ProfileState {
  readonly handle: string;
  readonly harness: string;
  readonly league: string;
  readonly leagueMin: number;
  /** LOCAL ONLY — never shared off-machine. Kept so the local UI can show it. */
  readonly totalTokens: number;
  readonly verified: boolean;
  readonly connectedAt: string;
}

/** Default directory for vibedating's local state: `~/.vibedating`. */
export function defaultStateDir(): string {
  return path.join(os.homedir(), '.vibedating');
}

/** A file-backed {@link ConsentStore}; survives across CLI/server/MCP processes. */
class FileConsentStore implements ConsentStore {
  constructor(private readonly file: string) {}

  load(): ConsentGrant[] {
    try {
      const raw = readFileSync(this.file, 'utf8');
      const data = JSON.parse(raw) as { grants?: ConsentGrant[] };
      return data.grants ?? [];
    } catch {
      return [];
    }
  }

  save(grants: ConsentGrant[]): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify({ grants }, null, 2) + '\n', 'utf8');
  }
}

/** Build a consent ledger backed by `<dir>/consent.json`. */
export function createLedger(dir: string = defaultStateDir()): ConsentLedger {
  return createConsentLedger(new FileConsentStore(path.join(dir, 'consent.json')));
}

function profilePath(dir: string): string {
  return path.join(dir, 'state.json');
}

/**
 * Read usage → bucket into a league → grant share consent → persist the profile.
 * Returns the resulting {@link ProfileState}. Idempotent: re-connecting refreshes
 * the snapshot and re-grants consent.
 */
export function connectProfile(
  snapshot: UsageSnapshot,
  handle: string,
  dir: string = defaultStateDir(),
): ProfileState {
  const lg = league(snapshot.totalTokens);
  createLedger(dir).grant(CONSENT_SCOPE, 'connect: league bucket only; raw usage stays local');
  const state: ProfileState = {
    handle,
    harness: snapshot.harness,
    league: lg.name,
    leagueMin: lg.min,
    totalTokens: snapshot.totalTokens,
    verified: snapshot.verified,
    connectedAt: new Date().toISOString(),
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(profilePath(dir), JSON.stringify(state, null, 2) + '\n', 'utf8');
  return state;
}

/** Load the persisted profile, or `null` if never connected. */
export function loadProfile(dir: string = defaultStateDir()): ProfileState | null {
  try {
    const raw = readFileSync(profilePath(dir), 'utf8');
    return JSON.parse(raw) as ProfileState;
  } catch {
    return null;
  }
}

/** Whether the user has consented to share their league bucket. */
export function canShareLeague(dir: string = defaultStateDir()): boolean {
  return createLedger(dir).allows(CONSENT_SCOPE);
}

/** Grant (idempotently) consent for live P2P discovery — the explicit opt-in. */
export function grantLiveConsent(dir: string = defaultStateDir()): void {
  createLedger(dir).grant(
    LIVE_CONSENT_SCOPE,
    'discover --live: share handle+league+harness (never raw usage) with same-league peers on the public DHT',
  );
}

/** Whether the user has opted in to live P2P discovery. Default OFF. */
export function canShareLive(dir: string = defaultStateDir()): boolean {
  return createLedger(dir).allows(LIVE_CONSENT_SCOPE);
}

/** Forget the profile and revoke share consent (league + live). Safe to call when never connected. */
export function resetProfile(dir: string = defaultStateDir()): void {
  createLedger(dir).revoke(CONSENT_SCOPE);
  createLedger(dir).revoke(LIVE_CONSENT_SCOPE);
  try {
    rmSync(profilePath(dir), { force: true });
  } catch {
    /* already gone */
  }
}
