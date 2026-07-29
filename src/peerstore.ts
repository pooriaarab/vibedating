/**
 * Local, on-disk record of peers we've shaken hands with (`~/.vibedating/peers.json`).
 *
 * This is purely local bookkeeping so the UI can show who you've met and when —
 * it never leaves the machine. Peers are keyed by ed25519 pubkey when verified,
 * falling back to handle for legacy peers, and every write rebuilds the stored
 * record key-by-key from the {@link PeerHello} allowlist so nothing beyond those
 * fields is ever persisted.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { defaultStateDir } from './state.js';
import type { PeerHello } from './handshake.js';

/** A peer we've shaken hands with, persisted locally. */
export interface StoredPeer extends PeerHello {
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  /** LOCAL metadata: when the last `msg` from this peer arrived (never on the wire). */
  readonly lastMessageAt?: string;
}

function peersPath(dir: string): string {
  return path.join(dir, 'peers.json');
}

/** Match a stored peer to a hello by pubkey when both have one, else by handle. */
function sameIdentity(a: PeerHello, b: PeerHello): boolean {
  return a.pubkey !== undefined && b.pubkey !== undefined
    ? a.pubkey === b.pubkey
    : a.handle === b.handle;
}

/** Load persisted live peers, or `[]` if none/corrupt. Local-only data. */
export function loadPeers(
  dir: string = defaultStateDir(),
  maxAgeMs: number = 7 * 24 * 60 * 60 * 1000,
): StoredPeer[] {
  try {
    const raw = readFileSync(peersPath(dir), 'utf8');
    const data = JSON.parse(raw) as { peers?: StoredPeer[] };
    if (!Array.isArray(data.peers)) return [];
    const now = Date.now();
    return data.peers.filter((p) => now - new Date(p.lastSeenAt).getTime() <= maxAgeMs);
  } catch {
    return [];
  }
}

/**
 * Record a successfully handshaken peer, keyed by pubkey (if verified) or handle
 * (legacy). Returns whether this peer is NEW (first time seen).
 */
export function recordPeer(
  hello: PeerHello,
  dir: string = defaultStateDir(),
  now: Date = new Date(),
): { peer: StoredPeer; isNew: boolean } {
  const peers = loadPeers(dir);
  const at = now.toISOString();
  // Built key-by-key from the allowlist — nothing beyond the PeerHello fields is
  // ever persisted, regardless of what the caller's object carries. Optional
  // fields are taken ONLY from this hello, so a stale value from an earlier
  // sighting can never linger after a peer stops sending it.
  const clean: PeerHello = {
    handle: hello.handle,
    league: hello.league,
    harness: hello.harness,
    ...(hello.verified !== undefined ? { verified: hello.verified } : {}),
    ...(hello.pubkey !== undefined ? { pubkey: hello.pubkey } : {}),
    ...(hello.identityVerified !== undefined ? { identityVerified: hello.identityVerified } : {}),
  };
  const existing = peers.findIndex((p) => sameIdentity(p, clean));
  let isNew: boolean;
  let peer: StoredPeer;
  if (existing >= 0) {
    isNew = false;
    const prev = peers[existing]!;
    peer = {
      ...clean,
      firstSeenAt: prev.firstSeenAt,
      lastSeenAt: at,
      // lastMessageAt is local metadata — carried over, never reset by a hello.
      ...(prev.lastMessageAt !== undefined ? { lastMessageAt: prev.lastMessageAt } : {}),
    };
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

/**
 * Stamp `lastMessageAt` on a stored peer (a `msg` just arrived from them).
 * Local metadata only; never on the wire. Returns false when the handle isn't
 * a known peer. Never throws — best-effort bookkeeping.
 */
export function recordPeerMessage(
  peer: PeerHello,
  dir: string = defaultStateDir(),
  now: Date = new Date(),
): boolean {
  try {
    const peers = loadPeers(dir);
    const idx = peers.findIndex((p) => sameIdentity(p, peer));
    if (idx < 0) return false;
    peers[idx] = { ...peers[idx]!, lastMessageAt: now.toISOString() };
    mkdirSync(dir, { recursive: true });
    writeFileSync(peersPath(dir), JSON.stringify({ peers }, null, 2) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}
