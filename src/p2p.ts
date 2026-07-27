/**
 * Live P2P matching over the hyperswarm DHT — no central server.
 *
 * Discovery: the league bucket computed by `connect` is hashed into a 32-byte
 * topic (`sha256('vibedate:' + league)`). Peers in the same league join the
 * same topic and find each other on the public DHT (NAT hole-punching and
 * connection encryption come from hyperswarm/hyperdht).
 *
 * Handshake: on each encrypted peer connection both sides immediately send a
 * single JSON line with ONLY { handle, league, harness }. Raw token usage is
 * never sent, and the parser builds its result from an allowlist of keys, so
 * anything a peer adds beyond those three fields is dropped on receipt.
 *
 * Consent: this module never decides policy — callers (the CLI) gate
 * {@link startDiscovery} behind the `share:live` consent grant (see state.ts).
 * The {@link LIVE_NOTICE} line is what the CLI prints before joining.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Harness, VibeEvent } from '@pooriaarab/vibe-core';
import { makeEvent, notify as vibeCoreNotify } from '@pooriaarab/vibe-core';
import { defaultStateDir } from './state.js';

/* -------------------------------------------------------------------------- */
/* Topic derivation                                                           */
/* -------------------------------------------------------------------------- */

/** Namespace prefix so vibedating topics never collide with other DHT traffic. */
export const TOPIC_PREFIX = 'vibedate:';

/**
 * Derive the 32-byte DHT topic for a league bucket. Deterministic: everyone in
 * the same league anywhere in the world hashes to the same topic, which is the
 * entire discovery mechanism. Pure.
 */
export function leagueTopic(leagueName: string): Buffer {
  return createHash('sha256').update(`${TOPIC_PREFIX}${leagueName}`, 'utf8').digest();
}

/* -------------------------------------------------------------------------- */
/* Handshake                                                                  */
/* -------------------------------------------------------------------------- */

/** The ONLY three fields that ever leave the machine over a peer connection. */
export interface PeerHello {
  readonly handle: string;
  readonly league: string;
  readonly harness: string;
}

/** One-line privacy notice printed before joining the swarm. */
export const LIVE_NOTICE =
  'live discovery: sharing only your handle + league + harness (never raw usage) with same-league peers on the public DHT';

/* Defensive caps so a malicious or buggy peer can't make us retain junk. */
const MAX_HANDLE_LEN = 64;
const MAX_LEAGUE_LEN = 32;
const MAX_HARNESS_LEN = 64;
const MAX_HANDSHAKE_LEN = 4096;

/** How often a discovery session re-runs an announce/lookup round. */
const REFRESH_INTERVAL_MS = 5_000;

/**
 * Serialize a hello to the single JSON line sent on connect. Built key-by-key
 * from the allowlist — even if a caller sneaks extra properties onto the
 * object, they cannot leak into the wire format.
 */
export function serializeHandshake(hello: PeerHello): string {
  return JSON.stringify({
    handle: hello.handle,
    league: hello.league,
    harness: hello.harness,
  });
}

/**
 * Parse one incoming handshake line. Returns `null` for anything malformed
 * (bad JSON, non-object, missing/oversized handle or league). The result is
 * constructed from an allowlist of keys, so any extra fields a peer sends —
 * in particular any raw-usage field — are ignored and never retained.
 */
export function parseHandshake(raw: string | Buffer): PeerHello | null {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  if (text.length > MAX_HANDSHAKE_LEN) return null;
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
  if (typeof handle !== 'string' || handle.length === 0 || handle.length > MAX_HANDLE_LEN) {
    return null;
  }
  if (typeof league !== 'string' || league.length === 0 || league.length > MAX_LEAGUE_LEN) {
    return null;
  }
  const harness = rec['harness'];
  return {
    handle,
    league,
    harness:
      typeof harness === 'string' && harness.length > 0 && harness.length <= MAX_HARNESS_LEN
        ? harness
        : 'unknown',
  };
}

/* -------------------------------------------------------------------------- */
/* Peer persistence (~/.vibedating/peers.json)                                 */
/* -------------------------------------------------------------------------- */

/** A peer we've shaken hands with, persisted locally. */
export interface StoredPeer extends PeerHello {
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

function peersPath(dir: string): string {
  return path.join(dir, 'peers.json');
}

/** Load persisted live peers, or `[]` if none/corrupt. Local-only data. */
export function loadPeers(dir: string = defaultStateDir()): StoredPeer[] {
  try {
    const raw = readFileSync(peersPath(dir), 'utf8');
    const data = JSON.parse(raw) as { peers?: StoredPeer[] };
    return Array.isArray(data.peers) ? data.peers : [];
  } catch {
    return [];
  }
}

/**
 * Record a successfully handshaken peer, keyed by handle (a peer may reconnect
 * from a different key). Returns whether this handle is NEW (first time seen).
 */
export function recordPeer(
  hello: PeerHello,
  dir: string = defaultStateDir(),
  now: Date = new Date(),
): { peer: StoredPeer; isNew: boolean } {
  const peers = loadPeers(dir);
  const at = now.toISOString();
  // Built key-by-key from the allowlist — nothing beyond handle/league/harness
  // is ever persisted, regardless of what the caller's object carries.
  const clean: PeerHello = { handle: hello.handle, league: hello.league, harness: hello.harness };
  const existing = peers.findIndex((p) => p.handle === clean.handle);
  let isNew: boolean;
  let peer: StoredPeer;
  if (existing >= 0) {
    isNew = false;
    peer = { ...peers[existing]!, ...clean, lastSeenAt: at };
    peers[existing] = peer;
  } else {
    isNew = true;
    peer = { ...clean, firstSeenAt: at, lastSeenAt: at };
    peers.push(peer);
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(peersPath(dir), JSON.stringify({ peers }, null, 2) + '\n', 'utf8');
  return { peer, isNew };
}

/* -------------------------------------------------------------------------- */
/* Discovery session                                                          */
/* -------------------------------------------------------------------------- */

/** Injection point for the match notification (defaults to vibe-core notify). */
export type NotifySink = (event: VibeEvent) => void;

export interface DiscoveryOptions {
  /** What we broadcast. Must already be consent-gated by the caller. */
  readonly hello: PeerHello;
  /**
   * Override the joined topic (tests pass a random one on an isolated DHT).
   * Defaults to {@link leagueTopic}`(hello.league)`.
   */
  readonly topic?: Buffer;
  /** DHT bootstrap nodes; omit for the public DHT. Tests pass a local testnet. */
  readonly bootstrap?: ReadonlyArray<{ readonly host: string; readonly port: number }>;
  /** Where peers.json lives. Defaults to ~/.vibedating. */
  readonly stateDir?: string;
  /** Called after each accepted handshake; `isNew` = first time this handle is seen. */
  readonly onPeer?: (peer: PeerHello, isNew: boolean) => void;
  /** Match-notification sink (tests capture with a fake). Best-effort. */
  readonly notify?: NotifySink;
}

export interface DiscoverySession {
  /** The 32-byte topic actually joined. */
  readonly topic: Buffer;
  /** What we broadcast on every connection. */
  readonly hello: PeerHello;
  /** Live peer set, keyed by the remote's public key (hex). */
  readonly peers: ReadonlyMap<string, PeerHello>;
  /** Resolves when the first DHT announce/lookup round for the topic completes. */
  readonly ready: Promise<unknown>;
  /** Leave the topic and destroy the node. Idempotent. */
  close(): Promise<void>;
}

/**
 * Join the swarm on the league topic and handshake with every peer that
 * connects. CONSENT GATE LIVES WITH THE CALLER — never call this without the
 * `share:live` grant (or an explicit `--live` opt-in in the same breath).
 */
export async function startDiscovery(opts: DiscoveryOptions): Promise<DiscoverySession> {
  const { hello, stateDir = defaultStateDir(), onPeer, notify = vibeCoreNotify } = opts;
  const topic = opts.topic ?? leagueTopic(hello.league);

  // Imported lazily so non-live commands (`matches`, `mcp`, `--help`) never pay
  // for hyperswarm's native stack (udx/sodium) — it loads on first live use.
  const { default: Hyperswarm } = await import('hyperswarm');
  const swarm = new Hyperswarm(opts.bootstrap === undefined ? {} : { bootstrap: opts.bootstrap });

  // Join only after the DHT node has routes: an announce/lookup issued against
  // an un-bootstrapped node completes instantly against an empty routing table,
  // and the next refresh is ~10 minutes out — the topic would be invisible.
  await swarm.dht.fullyBootstrapped();

  const peers = new Map<string, PeerHello>();

  swarm.on('connection', (socket, info) => {
    const remoteKey = info.publicKey.toString('hex');

    // Both sides write their hello immediately, then read the peer's line.
    socket.write(serializeHandshake(hello) + '\n');

    let buf = '';
    socket.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim() === '') continue;
        const peer = parseHandshake(line);
        if (peer === null) continue;
        // The topic already restricts us to one league; a peer claiming a
        // different league on it is bogus — drop it.
        if (peer.league !== hello.league) continue;
        peers.set(remoteKey, peer);
        const { isNew } = recordPeer(peer, stateDir);
        if (isNew) {
          // New mutual same-league peer → one best-effort vibenotify event.
          try {
            notify(
              makeEvent('match', hello.harness as Harness, process.cwd(), {
                summary: `matched with ${peer.handle} - LIVE SAME LEAGUE`,
                handle: peer.handle,
                league: peer.league,
                harness: peer.harness,
              }),
            );
          } catch {
            /* notify is best-effort; never let it break discovery */
          }
        }
        onPeer?.(peer, isNew);
      }
    });
    socket.on('error', () => {
      /* peer vanished mid-handshake — fine, the swarm retries */
    });
  });

  const discovery = swarm.join(topic, { server: true, client: true });

  // Await the first announce/lookup round before returning: once it completes,
  // our record is stored on the DHT, so a peer joining AFTER us finds us in
  // its first round. A failed first round is retried by the refresher below.
  const ready: Promise<unknown> = discovery.flushed().catch(() => undefined);
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
    hello,
    peers,
    ready,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      clearInterval(refresher);
      try {
        await swarm.leave(topic);
      } catch {
        /* network already gone */
      }
      await swarm.destroy();
    },
  };
}

/** Random 32-byte topic for tests/local experiments — never collides with a real league topic. */
export function randomTopic(): Buffer {
  return randomBytes(32);
}
