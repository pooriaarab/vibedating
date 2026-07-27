/**
 * P2P matching layer — decentralized, serverless discovery over hyperswarm.
 *
 * There is no central directory. Peers find each other on the public DHT by
 * joining a league-scoped topic: sha256('vibedate:' + leagueBucket). Everyone
 * in the same league derives the same 32-byte key, so same-league peers meet
 * without any server.
 *
 * On each encrypted (Noise) connection the two sides exchange a one-line hello
 * carrying ONLY { handle, league, harness }. Raw token usage is never put on
 * the wire — {@link serializeHandshake} whitelists on the way out and
 * {@link parseHandshake} whitelists on the way in, so anything else a peer
 * sends (token counts, usage objects, …) is dropped at the parser and never
 * enters the process. The same whitelist is applied before persisting to
 * `~/.vibedating/peers.json`.
 *
 * Joining the swarm is CONSENT-GATED at the CLI layer (`discover --live`,
 * scope `share:live` in state.ts); this module only runs when called.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import Hyperswarm from 'hyperswarm';
import { makeEvent, notify as vibeCoreNotify } from '@pooriaarab/vibe-core';
import type { VibeEvent } from '@pooriaarab/vibe-core';
import { defaultStateDir } from './state.js';

/** Namespace prefix for every vibedate DHT topic. */
export const TOPIC_PREFIX = 'vibedate:';

/**
 * One-line notice printed before joining the swarm — the privacy contract the
 * user opted into, stated plainly.
 */
export const LIVE_NOTICE =
  'live: sharing handle + league + harness (never raw token usage) with same-league peers on the hyperswarm DHT';

/** The only fields that ever leave the machine on a live connection. */
export interface PeerHello {
  readonly handle: string;
  readonly league: string;
  readonly harness: string;
}

/**
 * Derive the 32-byte DHT topic for a league bucket. Pure: same league → same
 * topic; different league → different topic.
 */
export function leagueTopic(leagueName: string): Buffer {
  return createHash('sha256')
    .update(TOPIC_PREFIX + leagueName)
    .digest();
}

/** A random 32-byte topic — used by tests to stay off any real league topic. */
export function randomTopic(): Buffer {
  return randomBytes(32);
}

/* -------------------------------------------------------------------------- */
/* Handshake codec (whitelisted both ways)                                    */
/* -------------------------------------------------------------------------- */

/** Cap on a single hello line — a handshake bigger than this is not a hello. */
const MAX_HANDSHAKE_CHARS = 1024;
/** Cap on each hello field, so a peer can't stuff a bio into `handle`. */
const MAX_FIELD_CHARS = 128;
/** How often a discovery session re-runs an announce/lookup round. */
const REFRESH_INTERVAL_MS = 5_000;

function validField(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_FIELD_CHARS;
}

/**
 * Serialize our hello as a single JSON object — the only bytes we ever send
 * (the caller adds the newline frame). Built field-by-field so extra props on
 * the input object CANNOT leak onto the wire.
 */
export function serializeHandshake(hello: PeerHello): string {
  return JSON.stringify({
    handle: hello.handle,
    league: hello.league,
    harness: hello.harness,
  });
}

/**
 * Parse an incoming hello line. Whitelist-parses EXACTLY
 * { handle, league, harness }: every other field — raw usage, token counts,
 * anything — is ignored and never appears in the result. `handle` and `league`
 * are required; a missing/invalid `harness` degrades to `'unknown'` (it is
 * informational, not part of the match). Returns `null` for malformed input.
 */
export function parseHandshake(raw: string | Buffer): PeerHello | null {
  const text = (typeof raw === 'string' ? raw : raw.toString('utf8')).trim();
  if (text === '' || text.length > MAX_HANDSHAKE_CHARS) return null;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const rec = data as Record<string, unknown>;
  const handle = rec['handle'];
  const league = rec['league'];
  if (!validField(handle) || !validField(league)) return null;
  const harness = rec['harness'];
  return { handle, league, harness: validField(harness) ? harness : 'unknown' };
}

/**
 * Whether a parsed hello counts as a match candidate: not ourselves, and in
 * our league. (The topic already scopes discovery to one league; this is the
 * belt-and-suspenders check for a peer that joined the wrong topic.)
 */
function acceptPeer(ours: PeerHello, theirs: PeerHello): boolean {
  return theirs.handle !== ours.handle && theirs.league === ours.league;
}

/* -------------------------------------------------------------------------- */
/* Peer book (~/.vibedating/peers.json)                                       */
/* -------------------------------------------------------------------------- */

/** A discovered peer. Timestamps are the only local additions to the hello. */
export interface StoredPeer extends PeerHello {
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

function peersPath(dir: string): string {
  return path.join(dir, 'peers.json');
}

/** Load every stored peer (empty array when nothing was ever discovered). */
export function loadPeers(dir: string = defaultStateDir()): StoredPeer[] {
  try {
    const raw = readFileSync(peersPath(dir), 'utf8');
    const data = JSON.parse(raw) as { peers?: StoredPeer[] };
    return data.peers ?? [];
  } catch {
    return [];
  }
}

export interface RecordResult {
  readonly peer: StoredPeer;
  /** True only on the first sighting of this handle (drives the match notify). */
  readonly isNew: boolean;
}

/**
 * Upsert a discovered peer by handle: first sighting appends, later sightings
 * refresh league/harness + lastSeenAt. Rebuilt field-by-field (whitelist) so
 * nothing beyond the hello can be smuggled into the file. Persists immediately.
 */
export function recordPeer(
  hello: PeerHello,
  dir: string = defaultStateDir(),
  now: Date = new Date(),
): RecordResult {
  const ts = now.toISOString();
  const base: PeerHello = { handle: hello.handle, league: hello.league, harness: hello.harness };
  const peers = loadPeers(dir);
  const idx = peers.findIndex((p) => p.handle === hello.handle);
  const peer: StoredPeer =
    idx === -1
      ? { ...base, firstSeenAt: ts, lastSeenAt: ts }
      : { ...base, firstSeenAt: peers[idx]!.firstSeenAt, lastSeenAt: ts };
  const next = idx === -1 ? [...peers, peer] : peers.map((p, i) => (i === idx ? peer : p));
  mkdirSync(dir, { recursive: true });
  writeFileSync(peersPath(dir), JSON.stringify({ peers: next }, null, 2) + '\n', 'utf8');
  return { peer, isNew: idx === -1 };
}

/* -------------------------------------------------------------------------- */
/* Live discovery                                                             */
/* -------------------------------------------------------------------------- */

/** Sink for the 'match' notification. Defaults to vibe-core's `notify`. */
export type NotifySink = (event: VibeEvent) => void;

export interface DiscoveryOptions {
  /** Our hello — the only data shared with peers. */
  readonly hello: PeerHello;
  /** Topic to join; defaults to {@link leagueTopic}(hello.league). */
  readonly topic?: Buffer;
  /** DHT bootstrap nodes; omit for the public DHT (tests pass a local testnet). */
  readonly bootstrap?: readonly Hyperswarm.BootstrapNode[];
  /** Where peers.json lives; defaults to ~/.vibedating. */
  readonly stateDir?: string;
  /** Called once per NEW session peer: the hello plus whether first-seen ever. */
  readonly onPeer?: (peer: PeerHello, isNew: boolean) => void;
  /** Match-notification sink (tests inject; defaults to vibe-core `notify`). */
  readonly notify?: NotifySink;
}

export interface DiscoverySession {
  /** The topic this session is joined on. */
  readonly topic: Buffer;
  /** Live same-league peers discovered so far, keyed by handle. */
  readonly peers: ReadonlyMap<string, PeerHello>;
  /** The first announce/lookup round — already awaited before we returned. */
  readonly ready: Promise<void>;
  /** Leave the topic and destroy the node. Idempotent. */
  close(): Promise<void>;
}

/**
 * Join the swarm on the league topic and run the hello handshake on every
 * connection. Both sides write their hello first, so a single connection
 * completes the handshake in both directions.
 *
 * On each NEW mutual same-league peer: persist to peers.json, invoke
 * `onPeer`, and fire ONE best-effort vibe-core `notify` of kind 'match'
 * (mirroring the web app's /api/match bridge). Discovery runs in the
 * background; call {@link DiscoverySession.close} to leave cleanly.
 */
export async function startDiscovery(opts: DiscoveryOptions): Promise<DiscoverySession> {
  const topic = opts.topic ?? leagueTopic(opts.hello.league);
  const stateDir = opts.stateDir ?? defaultStateDir();
  const sink: NotifySink = opts.notify ?? vibeCoreNotify;
  const swarm = new Hyperswarm(
    opts.bootstrap === undefined ? {} : { bootstrap: opts.bootstrap },
  );
  const peers = new Map<string, PeerHello>();
  const ourLine = serializeHandshake(opts.hello) + '\n';

  swarm.on('connection', (socket) => {
    socket.write(ourLine);
    socket.on('error', () => {}); // a peer dropping must never crash discovery
    let pending = '';
    socket.on('data', (chunk: Buffer) => {
      if (pending.length > MAX_HANDSHAKE_CHARS) return; // no line yet — stop buffering
      pending += chunk.toString('utf8');
      const nl = pending.indexOf('\n');
      if (nl === -1) return;
      const hello = parseHandshake(pending.slice(0, nl));
      pending = '';
      if (hello === null || !acceptPeer(opts.hello, hello) || peers.has(hello.handle)) return;
      peers.set(hello.handle, hello);
      const { isNew } = recordPeer(hello, stateDir);
      opts.onPeer?.(hello, isNew);
      if (isNew) {
        try {
          sink(
            makeEvent('match', opts.hello.harness, process.cwd(), {
              summary: `matched with ${hello.handle} - SAME LEAGUE (live, p2p)`,
              handle: hello.handle,
              league: hello.league,
              via: 'hyperswarm',
            }),
          );
        } catch {
          /* best effort — a notification failure must never break discovery */
        }
      }
    });
  });

  const discovery = swarm.join(topic, { server: true, client: true });
  // Await the first announce+lookup round before returning: once it completes,
  // our record is stored on the DHT, so any peer joining AFTER us finds us in
  // its first round.
  const ready: Promise<void> = discovery.flushed().then(
    () => undefined,
    () => undefined, // a failed first round is retried by the refresher below
  );
  await ready;

  // hyperswarm re-refreshes a topic only every ~10 minutes — fine for a
  // long-lived daemon, wrong for a `discover` session: peers who join while
  // we're online should be noticed within seconds, and a first round that
  // missed or errored (the swarm swallows round errors) must not cost the
  // whole session. Re-run rounds on a short cadence until close().
  const refresher = setInterval(() => {
    void discovery.refresh({ server: true, client: true }).catch(() => {});
  }, REFRESH_INTERVAL_MS);
  refresher.unref();

  let closed = false;
  return {
    topic,
    peers,
    ready,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      clearInterval(refresher);
      await swarm.leave(topic);
      await swarm.destroy();
    },
  };
}
