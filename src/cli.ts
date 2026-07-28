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
import { createPairing } from './pairing.js';
import { canShareLive, connectProfile, grantLiveConsent, loadProfile } from './state.js';
import { createLiveBridge, startServer, type LiveBridge } from './server.js';
import { runMcp } from './mcp.js';

/** Mirrors package.json version (kept here; package.json imports are brittle under bundling). */
const VERSION = '0.3.0';

/** Recognized top-level commands, plus the synthetic help/version. */
export type Command =
  | 'connect'
  | 'matches'
  | 'discover'
  | 'open'
  | 'live'
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
  /** `discover --any` / `live --any`: match every league (not just ±1). Default false. */
  readonly any: boolean;
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
  let out: ParsedArgs = { command: null, port: undefined, live: false, dating: false, any: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--version' || a === '-v') {
      return { command: 'version', port: undefined, live: false, dating: false, any: false };
    }
    if (a === '--help' || a === '-h') {
      return { command: 'help', port: undefined, live: false, dating: false, any: false };
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
    if (a.startsWith('-')) continue; // ignore unknown flags
    const known: Command =
      a === 'connect' ||
      a === 'matches' ||
      a === 'discover' ||
      a === 'open' ||
      a === 'live' ||
      a === 'mcp' ||
      a === 'help'
        ? a
        : null;
    if (known !== null && out.command === null) {
      out = { ...out, command: known };
    }
  }
  return out;
}

function leagueLabel(name: string): string {
  return name === 'below-1M' ? 'below 1M (not yet in a league)' : `${name} League`;
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

async function cmdConnect(): Promise<number> {
  const harness: Harness = (process.env['VIBEDATING_HARNESS'] as Harness | undefined) ?? 'claude-code';
  const handle = process.env['VIBEDATING_HANDLE'] ?? '@you';
  const snapshot = await readUsage(harness);
  const profile = connectProfile(snapshot, handle);
  const lg = league(snapshot.totalTokens);
  process.stdout.write('\n');
  process.stdout.write(`  ${leagueLabel(lg.name)}\n`);
  process.stdout.write(`  handle: ${profile.handle}  ·  harness: ${profile.harness}\n`);
  process.stdout.write(
    `  verification: ${profile.verified ? 'verified (read-only OAuth)' : 'self-reported'}\n`,
  );
  process.stdout.write('\n');
  process.stdout.write('  • raw usage stays local · only league shared\n\n');
  return 0;
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
      `${livePeers.length} live peer${livePeers.length === 1 ? '' : 's'} in range (discovered over the DHT):\n\n`,
    );
    for (const p of livePeers) {
      process.stdout.write(`  ${p.handle.padEnd(28)} ${p.league} · ${p.harness}\n`);
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
      'Live discovery is off. It shares ONLY your handle + league + harness (never raw usage)\n' +
        'with same-league peers on the public DHT. Opt in: `vibedating discover --live`\n',
    );
    return 1;
  }

  const hello: PeerHello = {
    handle: profile.handle,
    league: profile.league,
    harness: profile.harness,
  };
  process.stdout.write('\n');
  process.stdout.write(`  ${LIVE_NOTICE}\n`);

  const { topics, acceptLeague } = discoveryScope(profile.league, any);
  const session = await startDiscovery({
    hello,
    topics,
    acceptLeague,
    onPeer: (peer, isNew) => {
      const { bullet, qual } = peerDirection(profile.league, peer.league);
      process.stdout.write(
        `  ${bullet} ${peer.handle} (${peer.league}${qual} · ${peer.harness})${isNew ? '  ← new match' : ''}\n`,
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

async function cmdOpen(port: number | undefined): Promise<number> {
  // Attach a live-signaling bridge IF the user has connected a profile, so the
  // web app's Video button can reach real same-league peers. `open` is treated
  // as the live opt-in exactly like `live` / `discover --live` (the command
  // invocation grants consent). Without a profile the web app still serves the
  // local dating demo — video just has nobody to call yet.
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
    const hello: PeerHello = {
      handle: profile.handle,
      league: profile.league,
      harness: profile.harness,
    };
    void startDiscovery({ hello, onLink: (link) => live!.addLink(link) })
      .then((s) => {
        session = s;
      })
      .catch(() => {
        /* offline / DHT unreachable — web app still works, video just has no peers yet */
      });
  }
  process.stdout.write(`\n  vibedating local web app → ${started.url}\n`);
  if (live) {
    process.stdout.write('  • live A/V (video) available for connected same-league peers\n');
  } else {
    process.stdout.write('  • connect first (`vibedating connect`) to enable live video\n');
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
 * pick-a-handle mode (`/open <handle>`). Consent-gated exactly like `discover`
 * (the command IS the opt-in). The wire protocol + pairing policy are unit
 * tested; this readline loop is manual-smoke only.
 */
async function cmdLive(dating: boolean, any: boolean): Promise<number> {
  const profile = loadProfile();
  if (!profile) {
    process.stderr.write('Not connected yet. Run `vibedating connect` first.\n');
    return 1;
  }
  // The `live` command IS the opt-in (mirrors `discover --live`).
  if (!canShareLive()) grantLiveConsent();
  if (!canShareLive()) {
    process.stderr.write('Could not enable live discovery. Try `vibedating discover --live`.\n');
    return 1;
  }

  const hello: PeerHello = {
    handle: profile.handle,
    league: profile.league,
    harness: profile.harness,
  };
  process.stdout.write('\n');
  process.stdout.write(`  ${LIVE_NOTICE}\n`);
  process.stdout.write(
    dating
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
      `  · matched ${link.hello.handle} (${link.hello.league}${qual} · ${link.hello.harness})\n`,
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
    onLink: (link) => pairing.add(link),
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

const HELP = `vibedating ${VERSION} — dating by tokens (local-first)

Usage:
  vibedating connect            Read your usage, compute + print your league
  vibedating matches [--live]   List candidates in your league (live peers if any)
  vibedating discover [--live] [--any]  Find live peers over the DHT (your league + adjacent; --any = everyone)
  vibedating live [--dating] [--any]    Live chat (your league + adjacent; --any = everyone; /next or --dating pick)
  vibedating open [--port N]    Serve the local web app (default: random port)
                                + live A/V video with connected same-league peers
  vibedating mcp                Run the stdio MCP server (profile, matches)
  vibedating --version
  vibedating --help

Privacy:
  Raw token usage is read and stored LOCALLY (~/.vibedating). Only the league
  bucket is ever shared. Live discovery (off by default) shares ONLY your
  handle + league + harness with same-league peers — opt in with --live.

Matching:
  discover/live match your league + adjacent (±1) tiers by default, so thin
  leagues and cross-league friends still connect. --any matches every league.

Env:
  VIBEDATING_TOKENS=<n>   Self-report a token count (e.g. 23400000 or 12M)
  VIBEDATING_HARNESS=<h>  Harness id (claude-code, codex, …)
  VIBEDATING_HANDLE=<@id> Display handle
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
    case 'matches':
      return cmdMatches(parsed.live);
    case 'discover':
      return cmdDiscover(parsed.live, parsed.any);
    case 'open':
      return cmdOpen(parsed.port);
    case 'live':
      return cmdLive(parsed.dating, parsed.any);
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
