/**
 * Live P2P matching over the hyperswarm DHT — no central server.
 *
 * Discovery: the league bucket computed by `connect` is hashed into a 32-byte
 * topic (`sha256('vibedate:' + league)`). Peers in the same league join the
 * same topic and find each other on the public DHT (NAT hole-punching and
 * connection encryption come from hyperswarm/hyperdht).
 *
 * Handshake: on each encrypted peer connection both sides immediately send a
 * single JSON line with ONLY the allowlisted fields { handle, league, harness,
 * verified, pubkey, nonce, sig }. Raw token usage is never sent, and the parser
 * builds its result from an allowlist of keys, so anything a peer adds beyond
 * those fields is dropped on receipt. pubkey/sig bind the hello to a persistent
 * ed25519 identity (see identity.ts): an invalid signature drops the peer.
 *
 * Consent: this module never decides policy — callers (the CLI) gate
 * {@link startDiscovery} behind the `share:live` consent grant (see state.ts).
 * The {@link LIVE_NOTICE} line is what the CLI prints before joining.
 */
import { randomBytes } from 'node:crypto';
import type { Harness, VibeEvent } from '@pooriaarab/vibe-core';
import { makeEvent, notify as vibeCoreNotify } from '@pooriaarab/vibe-core';
import { topicFor } from '@pooriaarab/vibe-core/ids';
import { sanitizePeerText } from '@pooriaarab/vibe-core/untrusted';
import { parseFrame, serializeFrame } from './frame.js';
import { LIVE_NOTICE, parseHandshake, serializeHandshake, type PeerHello } from './handshake.js';
import { classifyHelloIdentity } from './identity.js';
import { createPeerLink, type PeerLink } from './link.js';
import { loadPeers, recordPeer, recordPeerMessage, type StoredPeer } from './peerstore.js';
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
  // vibe-core/ids.topicFor returns the raw 32-byte sha256 Buffer — byte-identical
  // to the prior createHash('sha256').update(prefix+name).digest().
  return topicFor(TOPIC_PREFIX, leagueName);
}

/* -------------------------------------------------------------------------- */
/* Re-exports                                                                 */
/* -------------------------------------------------------------------------- */
/* The handshake wire form and the local peer store each live in their own     */
/* module now (handshake.ts, peerstore.ts). They're re-exported here so the     */
/* many existing `from './p2p.js'` imports keep working while this file stays   */
/* focused on discovery.                                                        */

export { LIVE_NOTICE, serializeHandshake, parseHandshake };
export type { PeerHello };
export { loadPeers, recordPeer, recordPeerMessage };
export type { StoredPeer };

/** How often a discovery session re-runs an announce/lookup round. */
const REFRESH_INTERVAL_MS = 5_000;

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
   * Defaults to {@link leagueTopic}`(hello.league)`. Ignored when {@link topics}
   * is set.
   */
  readonly topic?: Buffer;
  /**
   * ALL topics to join on the one swarm (e.g. your league + adjacent leagues),
   * so thin pools and cross-league friends still connect. Every topic is
   * joined, refreshed, and left on close. Defaults to `[topic]` — i.e. a single
   * own-league topic (the legacy behavior).
   */
  readonly topics?: readonly Buffer[];
  /**
   * Predicate over an incoming peer's advertised league. Defaults to EXACT
   * match against `hello.league` — the same privacy invariant as before. Widen
   * it (e.g. ±1 adjacency via {@link leaguesWithin}) to accept cross-league
   * peers that arrive on a shared topic.
   */
  readonly acceptLeague?: (peerLeague: string) => boolean;
  /**
   * Predicate over an incoming peer's advertised handle. A blocked peer's hello
   * is DROPPED exactly like a wrong-league one — never recorded to peers.json,
   * never notified, never handed to `onLink`/pairing. Default: nothing blocked.
   * The CLI passes one backed by the persisted blocklist (~/.vibedating).
   */
  readonly isBlocked?: (handle: string) => boolean;
  /** DHT bootstrap nodes; omit for the public DHT. Tests pass a local testnet. */
  readonly bootstrap?: ReadonlyArray<{ readonly host: string; readonly port: number }>;
  /** Where peers.json lives. Defaults to ~/.vibedating. */
  readonly stateDir?: string;
  /** Called after each accepted handshake; `isNew` = first time this handle is seen. */
  readonly onPeer?: (peer: PeerHello, isNew: boolean) => void;
  /**
   * Called once per connection with a live {@link PeerLink} over the same socket
   * (the hello was frame #1; subsequent frames flow to the link). Omit for the
   * plain `discover` behavior (no live chat). Existing discovery behavior is
   * unchanged when this is absent.
   */
  readonly onLink?: (link: PeerLink) => void;
  /** Match-notification sink (tests capture with a fake). Best-effort. */
  readonly notify?: NotifySink;
}

export interface DiscoverySession {
  /** The primary (first) joined topic. See {@link topics} for the full set. */
  readonly topic: Buffer;
  /** Every topic this session joined (primary first). */
  readonly topics: readonly Buffer[];
  /** What we broadcast on every connection. */
  readonly hello: PeerHello;
  /** Live peer set, keyed by the remote's public key (hex). */
  readonly peers: ReadonlyMap<string, PeerHello>;
  /** Resolves when the first DHT announce/lookup round for every topic completes. */
  readonly ready: Promise<unknown>;
  /** Leave every topic and destroy the node. Idempotent. */
  close(): Promise<void>;
}

/**
 * Join the swarm on the league topic and handshake with every peer that
 * connects. CONSENT GATE LIVES WITH THE CALLER — never call this without the
 * `share:live` grant (or an explicit `--live` opt-in in the same breath).
 */
export async function startDiscovery(opts: DiscoveryOptions): Promise<DiscoverySession> {
  const { hello, stateDir = defaultStateDir(), onPeer, onLink, notify = vibeCoreNotify } = opts;
  const isBlocked = opts.isBlocked;
  // Topics: explicit list (preferred) > single legacy `topic` > own-league default.
  const topics: Buffer[] = opts.topics
    ? [...opts.topics]
    : opts.topic !== undefined
      ? [opts.topic]
      : [leagueTopic(hello.league)];
  // League-accept predicate: default = EXACT own-league match, so the legacy
  // privacy invariant (only same-league peers are retained) is unchanged
  // unless a caller widens it (e.g. CLI default ±1, or `--any`).
  const acceptLeague: (peerLeague: string) => boolean =
    opts.acceptLeague ?? ((l) => l === hello.league);

  // Imported lazily so non-live commands (`matches`, `mcp`, `--help`) never pay
  // for hyperswarm's native stack (udx/sodium) — it loads on first live use.
  const { default: Hyperswarm } = await import('hyperswarm');
  // Explicit opt wins; otherwise VIBEDATE_BOOTSTRAP ("host:port,host:port") points
  // every live path (CLI, MCP, rooms) at a local testnet so the multi-process test
  // harness runs hermetically instead of on the public DHT.
  const bootstrap = opts.bootstrap ?? parseBootstrapEnv(process.env['VIBEDATE_BOOTSTRAP']);
  const swarm = new Hyperswarm(bootstrap === undefined ? {} : { bootstrap });

  // Join only after the DHT node has routes: an announce/lookup issued against
  // an un-bootstrapped node completes instantly against an empty routing table,
  // and the next refresh is ~10 minutes out — the topic would be invisible.
  await swarm.dht.fullyBootstrapped();

  const peers = new Map<string, PeerHello>();

  swarm.on('connection', (socket, info) => {
    const remoteKey = info.publicKey.toString('hex');

    // Send our hello as the FIRST frame on the connection. The live protocol
    // unifies the old ad-hoc handshake line into a typed frame so the whole
    // stream (hello + chat) shares one newline-JSON frame channel. The payload
    // is still ONLY the allowlisted PeerHello fields — raw usage is never on it.
    socket.write(
      serializeFrame({
        t: 'hello',
        handle: hello.handle,
        league: hello.league,
        harness: hello.harness,
        ...(hello.verified !== undefined ? { verified: hello.verified } : {}),
        ...(hello.pubkey !== undefined ? { pubkey: hello.pubkey } : {}),
        ...(hello.nonce !== undefined ? { nonce: hello.nonce } : {}),
        ...(hello.sig !== undefined ? { sig: hello.sig } : {}),
      }) + '\n',
    );

    // The hello handshake: buffer until the first newline-JSON hello, parse it,
    // enforce the league allowlist + the parseFrame field allowlist, then hand
    // the socket (and any leftover BYTES — which may already contain binary
    // media-chunks) to a PeerLink for all subsequent frames.
    let buf = Buffer.alloc(0);
    let handedOff = false;
    const onData = (chunk: Buffer): void => {
      if (handedOff) return; // PeerLink owns the socket now
      buf = buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([buf, chunk]);
      let nl: number;
      while ((nl = buf.indexOf(0x0a /* \n */)) >= 0) {
        const line = buf.subarray(0, nl).toString('utf8');
        buf = buf.subarray(nl + 1);
        if (line.trim() === '') continue;
        const frame = parseFrame(line);
        if (frame === null) continue; // malformed/unknown — drop, never crash
        if (frame.t !== 'hello') continue; // frame #1 must be the hello
        // Identity check BEFORE anything is retained: a hello claiming a pubkey
        // whose signature doesn't verify is an impersonation attempt — the peer
        // is DROPPED entirely (never recorded, never notified, never paired),
        // exactly like a wrong-league or blocked peer. No pubkey → legacy peer,
        // accepted but never identity-verified.
        const verdict = classifyHelloIdentity(frame);
        if (verdict === 'drop') continue;
        // Build the PeerHello from the allowlisted fields only — anything else
        // a peer stuffed onto the frame was dropped by parseFrame. nonce/sig are
        // one-time proof material: verified above, then discarded, never retained.
        const peer: PeerHello = {
          handle: frame.handle,
          league: frame.league,
          harness: frame.harness,
          ...(frame.verified !== undefined ? { verified: frame.verified } : {}),
          ...(verdict === 'verified' && frame.pubkey !== undefined
            ? { pubkey: frame.pubkey, identityVerified: true }
            : {}),
        };
        // Self-filter: you can't match yourself. Drop a peer presenting your own
        // identity pubkey (e.g. two of your own instances on one topic), or —
        // when neither side has a pubkey (legacy peers) — your own handle.
        if (
          (peer.pubkey !== undefined && peer.pubkey === hello.pubkey) ||
          (peer.pubkey === undefined && hello.pubkey === undefined && peer.handle === hello.handle)
        ) {
          continue;
        }
        // The joined topic(s) scope which peers can reach us, but a peer could
        // still arrive on a shared topic advertising a league we don't accept
        // — drop it. `acceptLeague` defaults to EXACT own-league match, so the
        // legacy privacy invariant is unchanged unless a caller widens it.
        if (!acceptLeague(peer.league)) continue;
        // A blocked peer is dropped exactly like a wrong-league one: never
        // recorded to peers.json, never notified, never handed to onLink. The
        // CLI injects a predicate backed by the persisted blocklist.
        if (isBlocked !== undefined && isBlocked(peer.handle)) continue;
        peers.set(remoteKey, peer);
        const { isNew } = recordPeer(peer, stateDir);
        if (isNew) {
          // New mutual same-league peer → one best-effort vibenotify event.
          try {
            notify(
              makeEvent('match', hello.harness as Harness, process.cwd(), {
                // input-safety: the handle is untrusted wire data — sanitized for
                // display (the structured `handle` field below stays verbatim).
                summary: `matched with ${sanitizePeerText(peer.handle)} - LIVE SAME LEAGUE`,
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

        // Hello consumed — frame #1 done. Hand the socket (and any leftover
        // bytes after the hello line) to a PeerLink so subsequent msg/typing/bye
        // frames flow to the caller's onLink. Discovery behavior above is
        // identical whether or not a link is requested.
        handedOff = true;
        socket.off('data', onData);
        if (onLink !== undefined) {
          const link = createPeerLink(socket, peer, buf);
          // Local metadata: every incoming msg stamps lastMessageAt on the
          // persisted peer. Best-effort; never affects the link.
          link.onMessage(() => {
            recordPeerMessage(peer, stateDir);
          });
          onLink(link);
        }
        buf = Buffer.alloc(0);
        return;
      }
    };
    socket.on('data', onData);
    socket.on('error', () => {
      /* peer vanished mid-handshake — fine, the swarm retries */
    });
  });

  // Join EVERY topic on the one swarm (e.g. your league + adjacent leagues).
  // Each join returns its own discovery handle; refresh + leave them all below.
  const discoveries = topics.map((t) => swarm.join(t, { server: true, client: true }));

  // Await the first announce/lookup round on EVERY topic before returning:
  // once they complete, our records are stored on the DHT, so a peer joining
  // AFTER us finds us in its first round. A failed first round is retried by
  // the refresher below.
  const ready: Promise<unknown> = Promise.all(
    discoveries.map((d) => d.flushed().catch(() => undefined)),
  );
  await ready;

  // hyperswarm re-refreshes a topic only every ~10 minutes — fine for a
  // long-lived daemon, wrong for a `discover` session: peers who join while
  // we're online should be noticed within seconds, and a first round that
  // missed or errored (the swarm swallows round errors) must not cost the
  // whole session. Re-run rounds on a short cadence until close().
  const refresher = setInterval(() => {
    for (const d of discoveries) void d.refresh({ server: true, client: true }).catch(() => {});
  }, REFRESH_INTERVAL_MS);
  refresher.unref();

  let closed = false;
  return {
    topic: topics[0]!, // primary (first) — kept for back-compat / display
    topics, // every joined topic (primary first)
    hello,
    peers,
    ready,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      clearInterval(refresher);
      for (const t of topics) {
        try {
          await swarm.leave(t);
        } catch {
          /* network already gone */
        }
      }
      await swarm.destroy();
    },
  };
}

/** Random 32-byte topic for tests/local experiments — never collides with a real league topic. */
export function randomTopic(): Buffer {
  return randomBytes(32);
}

/**
 * Parse a `VIBEDATE_BOOTSTRAP` value ("host:port,host:port") into DHT bootstrap
 * nodes, or `undefined` when unset/empty (→ public DHT). Malformed entries are
 * skipped; an all-bad list yields `undefined` so a typo never silently strands
 * the node on an empty testnet.
 */
function parseBootstrapEnv(
  raw: string | undefined,
): ReadonlyArray<{ readonly host: string; readonly port: number }> | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const nodes: Array<{ host: string; port: number }> = [];
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (trimmed === '') continue;
    const idx = trimmed.lastIndexOf(':');
    if (idx <= 0) continue;
    const host = trimmed.slice(0, idx);
    const port = Number(trimmed.slice(idx + 1));
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
    nodes.push({ host, port });
  }
  return nodes.length > 0 ? nodes : undefined;
}
