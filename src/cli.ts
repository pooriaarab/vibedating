#!/usr/bin/env node
/**
 * vibedating CLI — three faces, one local engine (web / CLI / MCP).
 *
 *   vibedating connect          read usage, compute + print your league
 *   vibedating matches          list candidates in your league (live peers if any)
 *   vibedating discover         join the DHT on your league topic, find live peers
 *   vibedating open             serve the local web app at http://localhost:PORT
 *   vibedating mcp              run the stdio MCP server
 *   vibedating --version
 *   vibedating --help
 *
 * No new deps: a tiny hand-rolled arg parser (parseArgs) over process.argv.
 */
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import {
  allLeagueNames,
  CANDIDATES,
  league,
  leagueIndex,
  leaguesWithin,
  matches,
  readUsage,
  type Harness,
  type LocalUsageSnapshot,
} from './index.js';
import {
  LIVE_NOTICE,
  leagueTopic,
  loadPeers,
  startDiscovery,
  TOPIC_PREFIX,
  type DiscoverySession,
  type PeerHello,
} from './p2p.js';
import { loadOrCreateIdentity, signHelloClaims } from './identity.js';
import { ensureHandle } from './handlegen.js';
import {
  daemonStatus,
  removeDaemonState,
  startDaemon,
  stopDaemon,
  writeDaemonState,
} from './daemon.js';
import { createPairing } from './pairing.js';
import {
  addBlock,
  canShareLive,
  connectProfile,
  defaultStateDir,
  grantLiveConsent,
  isBlocked,
  loadBlocklist,
  loadProfile,
  normalizeHandle,
  removeBlock,
  resolveHandle,
  sameHandle,
  saveHandle,
  type ProfileState,
} from './state.js';
import { createLiveBridge, startServer, type LiveBridge } from './server.js';
import { runMcp } from './mcp.js';

/** Mirrors package.json version (kept here; package.json imports are brittle under bundling). */
const VERSION = '0.4.1';

/** Recognized top-level commands, plus the synthetic help/version. */
export type Command =
  | 'connect'
  | 'matches'
  | 'discover'
  | 'open'
  | 'live'
  | 'find'
  | 'handle'
  | 'block'
  | 'unblock'
  | 'blocklist'
  | 'daemon'
  | 'mcp'
  | 'help'
  | 'version'
  | null;

export interface ParsedArgs {
  readonly command: Command;
  /** Port for `open --port`; undefined means "let the OS pick". */
  readonly port: number | undefined;
  /** Explicit opt-in to live P2P discovery (`discover --live`). Default false. */
  readonly live: boolean;
  /** `live --dating`: pick-a-handle mode vs omegle auto-pair. Default false. */
  readonly dating: boolean;
  /** `discover --any` / `live --any` / `open --any`: match every league (not just ±1). Default false. */
  readonly any: boolean;
  /** Positional argument for `handle`/`find` (e.g. `@name`). */
  readonly arg: string | undefined;
  /** `live --to <@handle>`: targeted match — auto-open that specific peer. */
  readonly to: string | undefined;
}

function parsePort(raw: string): number | undefined {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return undefined;
  return n;
}

/**
 * Parse argv (the slice AFTER the program name) into a command + options.
 * Pure: no IO, no process access — trivially unit-testable.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  let out: ParsedArgs = {
    command: null,
    port: undefined,
    live: false,
    dating: false,
    any: false,
    arg: undefined,
    to: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--version' || a === '-v') {
      return {
        command: 'version',
        port: undefined,
        live: false,
        dating: false,
        any: false,
        arg: undefined,
        to: undefined,
      };
    }
    if (a === '--help' || a === '-h') {
      return {
        command: 'help',
        port: undefined,
        live: false,
        dating: false,
        any: false,
        arg: undefined,
        to: undefined,
      };
    }
    if (a === '--live') {
      out = { ...out, live: true };
      continue;
    }
    if (a === '--any') {
      out = { ...out, any: true };
      continue;
    }
    if (a === '--dating') {
      out = { ...out, dating: true };
      continue;
    }
    if (a === '--port') {
      const next = argv[i + 1];
      if (next !== undefined) {
        const p = parsePort(next);
        if (p !== undefined) out = { ...out, port: p };
        i++;
      }
      continue;
    }
    if (a.startsWith('--port=')) {
      const p = parsePort(a.slice('--port='.length));
      if (p !== undefined) out = { ...out, port: p };
      continue;
    }
    if (a === '--to') {
      const next = argv[i + 1];
      if (next !== undefined) {
        out = { ...out, to: next };
        i++;
      }
      continue;
    }
    if (a.startsWith('--to=')) {
      out = { ...out, to: a.slice('--to='.length) };
      continue;
    }
    if (a.startsWith('-')) continue; // ignore unknown flags
    const known: Command =
      a === 'connect' ||
      a === 'matches' ||
      a === 'discover' ||
      a === 'open' ||
      a === 'live' ||
      a === 'find' ||
      a === 'handle' ||
      a === 'block' ||
      a === 'unblock' ||
      a === 'blocklist' ||
      a === 'daemon' ||
      a === 'mcp' ||
      a === 'help'
        ? a
        : null;
    if (known !== null && out.command === null) {
      out = { ...out, command: known };
    } else if (out.arg === undefined) {
      // First positional after the command → the command's argument
      // (e.g. `handle @name`, `find @x`, `block @y`).
      out = { ...out, arg: a };
    }
  }
  return out;
}

function leagueLabel(name: string): string {
  return name === 'below-1M' ? 'below 1M (not yet in a league)' : `${name} League`;
}

/** Compact token count for LOCAL display: 19_200_000_000 → "19.2B", 23_400_000 → "23.4M". */
function formatTokens(n: number): string {
  const trim = (v: number): string => String(Math.round(v * 10) / 10);
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${trim(n / 1e9)}B`;
  if (abs >= 1e6) return `${trim(n / 1e6)}M`;
  if (abs >= 1e3) return `${trim(n / 1e3)}k`;
  return String(n);
}

/**
 * Honest verification line for `connect` — where the usage number ACTUALLY came
 * from. Only `source === 'real'` (the harness's own local logs, read by
 * vibe-core) is "verified"; self-report and demo are labeled as what they are.
 * The token total is shown only here, on the local machine — never on the wire.
 */
function verificationText(snapshot: LocalUsageSnapshot): string {
  if (snapshot.source === 'real') {
    return `verified: real usage — ${formatTokens(snapshot.totalTokens)} tokens from ${snapshot.harness} logs`;
  }
  if (snapshot.source === 'self-report') return 'self-reported (unverified)';
  return 'demo (unverified)';
}

/**
 * Build the DHT topics + league-accept predicate for a live session.
 *
 * Adjacent (default): join your league ±1 topics, accept peers within ±1 — so
 * thin leagues and cross-league friends still connect. `--any`: join every
 * league topic, accept everyone. Your own league topic is always placed first
 * (the "primary" topic shown in the CLI + used for peers.json).
 */
function discoveryScope(
  myLeague: string,
  any: boolean,
): { topics: Buffer[]; acceptLeague: (peerLeague: string) => boolean } {
  const names = any ? allLeagueNames() : leaguesWithin(myLeague, 1);
  // Own league first → primary topic is always yours (display + back-compat).
  const ordered = [myLeague, ...names.filter((n) => n !== myLeague)];
  if (any) {
    return { topics: ordered.map(leagueTopic), acceptLeague: () => true };
  }
  const accepted = new Set(names);
  return {
    topics: ordered.map(leagueTopic),
    acceptLeague: (peerLeague: string) => accepted.has(peerLeague),
  };
}

/**
 * Predicate backed by the persisted blocklist (~/.vibedating/blocklist.json),
 * injected into {@link startDiscovery} so a blocked peer's hello is DROPPED exactly
 * like a wrong-league one — never recorded, never notified, never paired.
 */
function blockedChecker(): (handle: string) => boolean {
  return (handle: string) => isBlocked(handle);
}

/**
 * Direction marker for a discovered peer relative to your league, so
 * cross-league matches (thin pool / cross-league friends) are visible. Same
 * league → `sameBullet` (default `+`); higher/lower league → an up/down arrow
 * plus a ` · higher/lower league` qualifier.
 */
function peerDirection(
  myLeague: string,
  peerLeague: string,
  sameBullet = '+',
): { bullet: string; qual: string } {
  const d = leagueIndex(peerLeague) - leagueIndex(myLeague);
  if (d > 0) return { bullet: '↑', qual: ' · higher league' };
  if (d < 0) return { bullet: '↓', qual: ' · lower league' };
  return { bullet: sameBullet, qual: '' };
}

/**
 * The hello we broadcast: profile fields + the honest usage-verification flag
 * (true only when connect measured real local logs), signed with the persistent
 * ed25519 identity so the handle can't be impersonated. Never any raw usage.
 */
function buildHello(profile: ProfileState): PeerHello {
  const claims = {
    handle: resolveHandle(),
    league: profile.league,
    harness: profile.harness,
    verified: profile.verified,
  };
  return { ...claims, ...signHelloClaims(loadOrCreateIdentity(), claims) };
}

/**
 * Usage-verification mark for a peer: ✓ when their hello carried
 * `verified: true` (usage measured from real local logs), ~ otherwise
 * (self-reported, demo, or a legacy peer that predates the flag).
 */
function usageMark(peer: { verified?: boolean }): string {
  return peer.verified === true ? '✓' : '~';
}

/** Identity mark: 🔑 when the peer's hello signature verified against its key. */
function idMark(peer: { identityVerified?: boolean }): string {
  return peer.identityVerified === true ? ' 🔑' : '';
}

/** One-line legend printed wherever peer marks are shown. */
const MARKS_LEGEND =
  'marks: ✓ usage verified (real local logs) · ~ unverified (self-report/demo/legacy) · 🔑 identity-verified (signed hello)';

async function cmdConnect(): Promise<number> {
  const harness: Harness = (process.env['VIBEDATING_HARNESS'] as Harness | undefined) ?? 'claude-code';
  // Zero-friction: first connect mints + persists a memetic handle when none is
  // set (env override still wins as a one-off) — never silently ship as @you.
  const ensured = ensureHandle();
  const handle = ensured.handle;
  const snapshot = await readUsage(harness);
  const profile = connectProfile(snapshot, handle);
  // First connect generates the persistent ed25519 identity (mode 0600); later
  // runs reuse it. The pubkey signs every hello so the handle can't be forged.
  const identity = loadOrCreateIdentity();
  const lg = league(snapshot.totalTokens);
  process.stdout.write('\n');
  process.stdout.write(`  ${leagueLabel(lg.name)}\n`);
  process.stdout.write(`  handle: ${profile.handle}  ·  harness: ${profile.harness}\n`);
  if (ensured.generated) {
    process.stdout.write(`  assigned handle: ${profile.handle} — change it with: vibedate handle @name\n`);
  }
  process.stdout.write(`  verification: ${verificationText(snapshot)}\n`);
  process.stdout.write(`  identity: ed25519 ${identity.publicKeyHex.slice(0, 12)}… — signs your hello (🔑)\n`);
  process.stdout.write('\n');
  process.stdout.write('  • raw usage stays local · only league shared\n\n');
  return 0;
}

/**
 * `vibedate handle` → print the effective handle (env override > persisted >
 * default). `vibedate handle @name` → validate + persist it to
 * `~/.vibedating/handle.json` (and mirror onto an existing profile). A leading
 * '@' is optional; the canonical form always has one.
 */
async function cmdHandle(arg: string | undefined): Promise<number> {
  if (arg === undefined || arg.trim() === '') {
    const handle = resolveHandle();
    process.stdout.write(`${handle}\n`);
    const env = process.env['VIBEDATING_HANDLE'];
    if (env !== undefined && env.trim() !== '' && normalizeHandle(env) !== null) {
      process.stdout.write('  (env VIBEDATING_HANDLE overrides the persisted handle for this run)\n');
    }
    return 0;
  }
  try {
    const canonical = saveHandle(arg);
    process.stdout.write(`  handle set → ${canonical}  (saved to ~/.vibedating/handle.json)\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

async function cmdMatches(live: boolean): Promise<number> {
  const profile = loadProfile();
  if (!profile) {
    process.stderr.write('Not connected yet. Run `vibedating connect` first.\n');
    return 1;
  }
  if (live && !canShareLive()) {
    process.stderr.write(
      'Live matching is off (consent required). Opt in: `vibedating discover --live`.\n',
    );
    return 1;
  }
  // Live peers discovered over the DHT (same or adjacent league), if any.
  const myIdx = leagueIndex(profile.league);
  const livePeers = canShareLive()
    ? loadPeers().filter((p) => {
        const idx = leagueIndex(p.league);
        return idx >= 0 && Math.abs(idx - myIdx) <= 1;
      })
    : [];
  if (livePeers.length > 0) {
    process.stdout.write(`Your league: ${leagueLabel(profile.league)}\n`);
    process.stdout.write(
      `${livePeers.length} live peer${livePeers.length === 1 ? '' : 's'} in range (discovered over the DHT):\n`,
    );
    process.stdout.write(`  ${MARKS_LEGEND}\n\n`);
    for (const p of livePeers) {
      process.stdout.write(`  ${p.handle.padEnd(28)} ${p.league} · ${p.harness} ${usageMark(p)}${idMark(p)}\n`);
    }
    process.stdout.write('\n');
    return 0;
  }
  if (live) {
    process.stdout.write('No live peers discovered yet. Run `vibedating discover` and keep it on.\n');
    return 0;
  }
  // Fall back to the local seeded demo pool.
  const list = matches(profile.league, CANDIDATES);
  process.stdout.write(`Your league: ${leagueLabel(profile.league)}\n`);
  process.stdout.write(`${list.length} candidate${list.length === 1 ? '' : 's'} in range (local demo pool):\n\n`);
  if (list.length === 0) {
    process.stdout.write('  (no candidates in range)\n');
    return 0;
  }
  for (const c of list) {
    process.stdout.write(`  ${c.handle.padEnd(28)} ${c.league}\n`);
  }
  process.stdout.write('\n');
  return 0;
}

async function cmdDiscover(live: boolean, any: boolean): Promise<number> {
  const profile = loadProfile();
  if (!profile) {
    process.stderr.write('Not connected yet. Run `vibedating connect` first.\n');
    return 1;
  }
  // Consent gate: live discovery is OFF unless opted in. `--live` on this
  // command IS the opt-in (persisted, so future runs need no flag).
  if (live && !canShareLive()) grantLiveConsent();
  if (!canShareLive()) {
    process.stderr.write(
      'Live discovery is off. It shares ONLY your handle + league + harness + verified flag + identity pubkey\n' +
        '(never raw usage) with same-league peers on the public DHT. Opt in: `vibedating discover --live`\n',
    );
    return 1;
  }

  const hello = buildHello(profile);
  process.stdout.write('\n');
  process.stdout.write(`  ${LIVE_NOTICE}\n`);
  process.stdout.write(`  ${MARKS_LEGEND}\n`);

  const { topics, acceptLeague } = discoveryScope(profile.league, any);
  const session = await startDiscovery({
    hello,
    topics,
    acceptLeague,
    isBlocked: blockedChecker(),
    onPeer: (peer, isNew) => {
      const { bullet, qual } = peerDirection(profile.league, peer.league);
      process.stdout.write(
        `  ${bullet} ${peer.handle} (${peer.league}${qual} · ${peer.harness}) ${usageMark(peer)}${idMark(peer)}${isNew ? '  ← new match' : ''}\n`,
      );
    },
  });
  process.stdout.write(
    `  topic: ${TOPIC_PREFIX}${profile.league} → ${session.topic.toString('hex').slice(0, 12)}…` +
      `${topics.length > 1 ? ` (+${topics.length - 1} more)` : ''}\n`,
  );
  if (!any && session.peers.size === 0) {
    process.stdout.write(
      '  no one in your league yet — also listening to adjacent leagues (use --any to match anyone)\n',
    );
  }
  process.stdout.write(
    any
      ? '  listening for ANY league peers… (Ctrl+C to stop)\n\n'
      : '  listening for same + adjacent-league peers… (Ctrl+C to stop)\n\n',
  );

  // Run until interrupted; leave the swarm cleanly on the way out.
  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
  process.stdout.write('\n  leaving the swarm…\n');
  await session.close();
  process.stdout.write(
    `  ${session.peers.size} peer${session.peers.size === 1 ? '' : 's'} discovered · saved to ~/.vibedating/peers.json\n\n`,
  );
  return 0;
}

async function cmdOpen(port: number | undefined, any: boolean): Promise<number> {
  // Attach a live-signaling bridge IF the user has connected a profile, so the
  // web app can reach real peers. `open` is treated as the live opt-in exactly
  // like `live` / `discover --live` (the command invocation grants consent), and
  // honors the SAME league scoping as `live`/`discover`: your league ±1 by
  // default, every league with `--any`. Without a profile the web app still
  // serves the local dating demo — live just has nobody to reach yet.
  const profile = loadProfile();
  let live: LiveBridge | undefined;
  let session: DiscoverySession | undefined;
  if (profile) {
    if (!canShareLive()) grantLiveConsent();
    live = createLiveBridge();
  }
  // Serve the web app FIRST — it must load instantly and work OFFLINE. Live
  // discovery joins the DHT in the BACKGROUND: bootstrap can be slow, or with
  // no network never complete, and the local app must never wait on it.
  const started = await startServer({ port, live });
  if (profile && live) {
    process.stdout.write(`\n  ${LIVE_NOTICE}\n`);
    const hello = buildHello(profile);
    const { topics, acceptLeague } = discoveryScope(profile.league, any);
    void startDiscovery({
      hello,
      topics,
      acceptLeague,
      isBlocked: blockedChecker(),
      onLink: (link) => live!.addLink(link),
    })
      .then((s) => {
        session = s;
      })
      .catch(() => {
        /* offline / DHT unreachable — web app still works, live just has no peers yet */
      });
  }
  process.stdout.write(`\n  vibedating local web app → ${started.url}\n`);
  if (live) {
    process.stdout.write(
      any
        ? '  • live video + chat available for connected peers (ANY league — --any)\n'
        : '  • live video + chat available for connected peers (your league + adjacent; --any = everyone)\n',
    );
  } else {
    process.stdout.write('  • connect first (`vibedating connect`) to enable live video + chat\n');
  }
  process.stdout.write('  • raw usage stays local · only league shared\n');
  process.stdout.write('  (Ctrl+C to stop)\n\n');
  // Run until interrupted, then leave the swarm + close the server cleanly.
  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
  process.stdout.write('\n  shutting down…\n');
  if (session) await session.close();
  await new Promise<void>((resolve) => started.server.close(() => resolve()));
  return 0;
}

/**
 * `vibedating live [--dating]` — live text chat with same-league peers.
 *
 * Omegle by default (auto-pair; `/next` rolls a new peer). `--dating` advertises
 * pick-a-handle mode (`/open <handle>`). `--to <@handle>` is targeted: instead of
 * pairing the first random peer, only auto-open the one whose handle matches.
 * Consent-gated exactly like `discover` (the command IS the opt-in). The wire
 * protocol + pairing policy are unit tested; this readline loop is manual-smoke
 * only.
 */
async function cmdLive(dating: boolean, any: boolean, to: string | undefined): Promise<number> {
  const profile = loadProfile();
  if (!profile) {
    process.stderr.write('Not connected yet. Run `vibedating connect` first.\n');
    return 1;
  }
  // Validate a `--to` target up front so we fail fast on a bad handle.
  const target = to !== undefined ? normalizeHandle(to) : null;
  if (to !== undefined && target === null) {
    process.stderr.write(`invalid target handle: ${to}\n`);
    return 1;
  }
  // The `live` command IS the opt-in (mirrors `discover --live`).
  if (!canShareLive()) grantLiveConsent();
  if (!canShareLive()) {
    process.stderr.write('Could not enable live discovery. Try `vibedating discover --live`.\n');
    return 1;
  }

  const hello = buildHello(profile);
  process.stdout.write('\n');
  process.stdout.write(`  ${LIVE_NOTICE}\n`);
  process.stdout.write(`  ${MARKS_LEGEND}\n`);
  process.stdout.write(
    target !== null
      ? `  targeted — auto-opening ${target} when they connect (/quit to stop)\n`
      : dating
        ? '  dating mode — /open <handle> to pick a peer\n'
        : '  omegle mode — /next to roll a new peer\n',
  );

  const pairing = createPairing();
  pairing.onMatch((link) => {
    if (link === undefined) {
      process.stdout.write('  · idle — no peer right now\n');
      return;
    }
    const { qual } = peerDirection(profile.league, link.hello.league);
    process.stdout.write(
      `  · matched ${link.hello.handle} (${link.hello.league}${qual} · ${link.hello.harness}) ${usageMark(link.hello)}${idMark(link.hello)}\n`,
    );
    link.onMessage((m) => {
      process.stdout.write(`  <${link.hello.handle}> ${m.text}\n`);
    });
  });

  const { topics, acceptLeague } = discoveryScope(profile.league, any);
  const session = await startDiscovery({
    hello,
    topics,
    acceptLeague,
    isBlocked: blockedChecker(),
    onLink: (link) => {
      // Targeted (`--to`) mode: only pair the requested handle. Other peers are
      // noted and politely declined (socket closed) so the session waits for the
      // specific peer instead of auto-pairing the first random one.
      if (target !== null && !sameHandle(link.hello.handle, target)) {
        const { qual } = peerDirection(profile.league, link.hello.league);
        process.stdout.write(
          `  + ${link.hello.handle} (${link.hello.league}${qual}) ${usageMark(link.hello)}${idMark(link.hello)} — not your target\n`,
        );
        link.close();
        return;
      }
      if (target !== null) {
        process.stdout.write(`  ★ found ${link.hello.handle} — auto-opening\n`);
      }
      pairing.add(link);
    },
  });
  process.stdout.write(
    `  topic: ${TOPIC_PREFIX}${profile.league} → ${session.topic.toString('hex').slice(0, 12)}…` +
      `${topics.length > 1 ? ` (+${topics.length - 1} more)` : ''}\n`,
  );
  process.stdout.write('  type to chat · /next · /open <handle> · /quit\n');
  process.stdout.write('  video chat: live A/V runs in the web app — run `vibedating open`\n\n');

  // Read stdin line by line; slash-commands drive the pairing policy.
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const stop = (): void => {
    rl.close();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  for await (const line of rl) {
    const text = line.trim();
    if (text === '/quit') break;
    if (text === '/next') {
      pairing.next();
      continue;
    }
    if (text.startsWith('/open ')) {
      const handle = text.slice('/open '.length).trim();
      if (pairing.open(handle) === undefined) {
        process.stdout.write(`  · no available peer "${handle}"\n`);
      }
      continue;
    }
    if (text === '') continue;
    const cur = pairing.current();
    if (cur !== undefined) {
      cur.send(text);
    } else {
      process.stdout.write('  · no peer yet — waiting for a match…\n');
    }
  }

  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  const cur = pairing.current();
  if (cur !== undefined) cur.close();
  process.stdout.write('\n  leaving the swarm…\n');
  await session.close();
  process.stdout.write('\n');
  return 0;
}

/**
 * `vibedate find <@handle> [--any]` — targeted discovery, not omegle.
 *
 * Joins discovery on your league (+ adjacent, or --any for every league) and
 * watches for ONE specific handle. When that peer connects it is highlighted
 * (★ found); other peers are listed faintly. Reuses startDiscovery's onPeer and
 * filters by handle via sameHandle() (leading '@' optional). If the target never
 * shows up before Ctrl+C, says so. Consent-gated like every live command.
 */
async function cmdFind(targetArg: string | undefined, any: boolean): Promise<number> {
  if (targetArg === undefined || targetArg.trim() === '') {
    process.stderr.write('usage: vibedating find <@handle> [--any]\n');
    return 1;
  }
  const target = normalizeHandle(targetArg);
  if (target === null) {
    process.stderr.write(`invalid handle: ${targetArg}\n`);
    return 1;
  }
  const profile = loadProfile();
  if (!profile) {
    process.stderr.write('Not connected yet. Run `vibedating connect` first.\n');
    return 1;
  }
  // The `find` command IS the opt-in (mirrors `discover --live`).
  if (!canShareLive()) grantLiveConsent();
  if (!canShareLive()) {
    process.stderr.write('Could not enable live discovery. Try `vibedating discover --live`.\n');
    return 1;
  }

  const hello = buildHello(profile);
  process.stdout.write('\n');
  process.stdout.write(`  ${LIVE_NOTICE}\n`);
  process.stdout.write(`  ${MARKS_LEGEND}\n`);
  process.stdout.write(
    `  looking for ${target} in your league${any ? ' (+ every league)' : ' + adjacent'}…\n`,
  );

  let found = false;
  const { topics, acceptLeague } = discoveryScope(profile.league, any);
  const session = await startDiscovery({
    hello,
    topics,
    acceptLeague,
    isBlocked: blockedChecker(),
    onPeer: (peer) => {
      const { qual } = peerDirection(profile.league, peer.league);
      if (sameHandle(peer.handle, target)) {
        found = true;
        process.stdout.write(
          `  ★ found ${peer.handle} (${peer.league}${qual} · ${peer.harness}) ${usageMark(peer)}${idMark(peer)}\n`,
        );
      } else {
        process.stdout.write(
          `  + ${peer.handle} (${peer.league}${qual}) ${usageMark(peer)}${idMark(peer)} — not your target\n`,
        );
      }
    },
  });
  process.stdout.write(
    `  topic: ${TOPIC_PREFIX}${profile.league} → ${session.topic.toString('hex').slice(0, 12)}…` +
      `${topics.length > 1 ? ` (+${topics.length - 1} more)` : ''}\n`,
  );
  process.stdout.write('  (Ctrl+C to stop)\n\n');

  // Run until interrupted; report whether the target was ever seen.
  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
  process.stdout.write('\n  leaving the swarm…\n');
  await session.close();
  if (!found) {
    process.stdout.write(`  ✗ ${target} was not found this session\n\n`);
  } else {
    process.stdout.write('\n');
  }
  return 0;
}

/**
 * `vibedate block <@handle>` — add a handle to the persisted blocklist
 * (~/.vibedating/blocklist.json). A blocked peer's hello is dropped on arrival
 * (never recorded, never notified, never paired). Idempotent.
 */
async function cmdBlock(arg: string | undefined): Promise<number> {
  if (arg === undefined || arg.trim() === '') {
    process.stderr.write('usage: vibedating block <@handle>\n');
    return 1;
  }
  const canonical = normalizeHandle(arg);
  if (canonical === null) {
    process.stderr.write(`invalid handle: ${arg}\n`);
    return 1;
  }
  const { blocked, changed } = addBlock(canonical);
  process.stdout.write(
    changed
      ? `  blocked ${canonical} (saved to ~/.vibedating/blocklist.json)\n`
      : `  ${canonical} is already blocked\n`,
  );
  process.stdout.write(`  ${blocked.length} handle${blocked.length === 1 ? '' : 's'} blocked\n`);
  return 0;
}

/** `vibedate unblock <@handle>` — remove a handle from the blocklist. Idempotent. */
async function cmdUnblock(arg: string | undefined): Promise<number> {
  if (arg === undefined || arg.trim() === '') {
    process.stderr.write('usage: vibedating unblock <@handle>\n');
    return 1;
  }
  const canonical = normalizeHandle(arg);
  if (canonical === null) {
    process.stderr.write(`invalid handle: ${arg}\n`);
    return 1;
  }
  const { blocked, changed } = removeBlock(canonical);
  process.stdout.write(
    changed
      ? `  unblocked ${canonical}\n`
      : `  ${canonical} was not blocked\n`,
  );
  process.stdout.write(`  ${blocked.length} handle${blocked.length === 1 ? '' : 's'} blocked\n`);
  return 0;
}

/** `vibedate blocklist` — print the persisted blocklist. */
async function cmdBlocklist(): Promise<number> {
  const blocked = loadBlocklist();
  if (blocked.length === 0) {
    process.stdout.write('  (blocklist is empty)\n');
    return 0;
  }
  process.stdout.write(`  ${blocked.length} blocked handle${blocked.length === 1 ? '' : 's'}:\n`);
  for (const h of blocked) process.stdout.write(`  ${h}\n`);
  return 0;
}

/**
 * `vibedate daemon run` — the actual daemon process (spawned detached by
 * `daemon start`, or directly by the installed launchd/systemd service).
 * NOTIFY-ONLY: joins discovery and fires a vibe-core notify() on each NEW
 * match (inside startDiscovery) — it never passes onLink, so chat/video are
 * never auto-opened. Needs NO stdin: runs until SIGTERM/SIGINT, so it works
 * unattended/backgrounded (no EOF death).
 */
async function cmdDaemonRun(any: boolean): Promise<number> {
  const profile = loadProfile();
  if (!profile) {
    process.stderr.write('Not connected yet. Run `vibedating connect` first.\n');
    return 1;
  }
  // Consent-gated exactly like `live`/`open`: invoking the daemon IS the opt-in.
  if (!canShareLive()) grantLiveConsent();
  const dir = defaultStateDir();
  writeDaemonState(dir, { pid: process.pid, startedAt: new Date().toISOString(), any, version: VERSION });

  const hello = buildHello(profile);
  const { topics, acceptLeague } = discoveryScope(profile.league, any);
  const session = await startDiscovery({
    hello,
    topics,
    acceptLeague,
    isBlocked: blockedChecker(),
    onPeer: (peer, isNew) => {
      process.stdout.write(
        `  [${new Date().toISOString()}] ${isNew ? 'NEW match' : 'peer seen'}: ${peer.handle} (${peer.league} · ${peer.harness})\n`,
      );
    },
  });
  process.stdout.write(
    `  vibedating daemon running (pid ${process.pid}) — notify-only${any ? ' · --any' : ''}\n`,
  );

  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
  await session.close();
  removeDaemonState(dir);
  process.stdout.write('  daemon stopped\n');
  return 0;
}

/**
 * `vibedate daemon [start|stop|status]` — manage the notify-only background
 * daemon. `run` is the internal foreground entry (used by start/launchd/systemd).
 */
async function cmdDaemon(arg: string | undefined, any: boolean): Promise<number> {
  switch (arg) {
    case 'start': {
      if (loadProfile() === null) {
        process.stderr.write('Not connected yet. Run `vibedating connect` first.\n');
        return 1;
      }
      const r = startDaemon({ any, version: VERSION });
      if (!r.started) {
        process.stdout.write(`  ${r.reason}\n`);
        return 0;
      }
      process.stdout.write(`  daemon started (pid ${r.pid}) — notify-only: alerts on NEW matches, never opens chat/video\n`);
      process.stdout.write(`  logs: ~/.vibedating/daemon.log · stop: vibedate daemon stop\n`);
      return 0;
    }
    case 'stop': {
      const r = await stopDaemon();
      process.stdout.write(
        r.stopped ? `  daemon stopped (pid ${r.pid})\n` : `  ${r.reason}\n`,
      );
      return 0;
    }
    case 'status': {
      const s = daemonStatus();
      if (s.running && s.state !== null) {
        process.stdout.write(
          `  daemon running (pid ${s.state.pid}) since ${s.state.startedAt}${s.state.any ? ' · --any' : ''}\n`,
        );
      } else {
        process.stdout.write('  daemon not running\n');
      }
      return 0;
    }
    case 'run':
      return cmdDaemonRun(any);
    default:
      process.stderr.write('usage: vibedating daemon [start|stop|status] [--any]\n');
      return 1;
  }
}

const HELP = `vibedating ${VERSION} — dating by tokens (local-first)

Usage:
  vibedating connect            Read your usage, compute + print your league
  vibedating matches [--live]   List candidates in your league (live peers if any)
  vibedating discover [--live] [--any]  Find live peers over the DHT (your league + adjacent; --any = everyone)
  vibedating live [--dating] [--any] [--to @handle]  Live chat (your league + adjacent; --any = everyone; /next or --dating pick; --to targets one peer)
  vibedating find <@handle> [--any]  Search the DHT for one specific handle (★ highlights a match)
  vibedating handle [@name]     Print or set your handle (persisted; a leading '@' is optional)
  vibedating block <@handle>    Block a handle — their hello is dropped (never recorded/paired)
  vibedating unblock <@handle>  Remove a handle from the blocklist
  vibedating blocklist          List blocked handles
  vibedating daemon [start|stop|status] [--any]  Manage the notify-only background
                                daemon — alerts on NEW matches, never opens chat/video
  vibedating open [--port N] [--any]  Serve the local web app (default: random port)
                                + live video + chat with connected peers
                                (your league + adjacent; --any = every league)
  vibedating mcp                Run the stdio MCP server (profile, matches)
  vibedating --version
  vibedating --help

Privacy:
  Raw token usage is read and stored LOCALLY (~/.vibedating). Only the league
  bucket is ever shared. Live discovery (off by default) shares ONLY your
  handle + league + harness + verified flag + identity pubkey (an ed25519 key
  generated on first connect, stored 0600 in ~/.vibedating/identity.json) with
  same-league peers — opt in with --live. Peers are marked: ✓ usage verified
  (real local logs) · ~ unverified · 🔑 identity-verified (signed hello).

Matching:
  discover/live/open match your league + adjacent (±1) tiers by default, so
  thin leagues and cross-league friends still connect. --any matches every
  league. find / live --to look for one specific handle instead of the first
  random peer.

Env:
  VIBEDATING_TOKENS=<n>   Self-report a token count (e.g. 23400000 or 12M)
  VIBEDATING_HARNESS=<h>  Harness id (claude-code, codex, …)
  VIBEDATING_HANDLE=<@id> Display handle (one-off override; not persisted)
`;

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  switch (parsed.command) {
    case 'version':
      process.stdout.write(`vibedating ${VERSION}\n`);
      return 0;
    case 'help':
    case null:
      process.stdout.write(HELP);
      return 0;
    case 'connect':
      return cmdConnect();
    case 'handle':
      return cmdHandle(parsed.arg);
    case 'block':
      return cmdBlock(parsed.arg);
    case 'unblock':
      return cmdUnblock(parsed.arg);
    case 'blocklist':
      return cmdBlocklist();
    case 'daemon':
      return cmdDaemon(parsed.arg, parsed.any);
    case 'matches':
      return cmdMatches(parsed.live);
    case 'discover':
      return cmdDiscover(parsed.live, parsed.any);
    case 'open':
      return cmdOpen(parsed.port, parsed.any);
    case 'live':
      return cmdLive(parsed.dating, parsed.any, parsed.to);
    case 'find':
      return cmdFind(parsed.arg, parsed.any);
    case 'mcp':
      await runMcp();
      return 0;
  }
}

// Run only when invoked as the entry script (not when imported, e.g. by tests).
const entryUrl = process.argv[1];
if (entryUrl !== undefined) {
  let isMain = false;
  try {
    isMain = true;
  } catch {
    isMain = false;
  }
  if (isMain) {
    void main(process.argv.slice(2)).then(
      (code) => {
        if (code !== 0) process.exit(code);
      },
      (err) => {
        process.stderr.write(err instanceof Error ? `${err.stack ?? err.message}\n` : `${String(err)}\n`);
        process.exit(1);
      },
    );
  }
}
