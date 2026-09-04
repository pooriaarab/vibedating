/**
 * The vibedating peer handshake: the ONLY data that leaves the machine over a
 * peer connection, and the allowlist parser that receives it.
 *
 * On each encrypted connection both sides send a single JSON line carrying only
 * { handle, league, harness, verified, pubkey, nonce, sig }. Raw token usage is
 * never sent, and the parser rebuilds its result key-by-key from an allowlist,
 * so anything a peer adds beyond those fields is dropped on receipt. pubkey/sig
 * bind the hello to a persistent ed25519 identity (see identity.ts).
 *
 * Pure + transport-agnostic: this module knows nothing about the DHT, sockets,
 * or discovery — it only shapes and validates the wire form, which keeps it
 * trivially unit-testable and keeps that security boundary in one place.
 */

/**
 * The fields that ever leave the machine over a peer connection: handle, league,
 * harness, and (optionally) the self-asserted usage-verification flag plus the
 * identity proof (pubkey/nonce/sig). NEVER raw usage — no token totals, no logs.
 * `verified`/`pubkey` are undefined for legacy peers that predate them; both
 * `undefined` and `false` display as unverified (~).
 */
export interface PeerHello {
  readonly handle: string;
  readonly league: string;
  readonly harness: string;
  /**
   * Self-asserted: the sender's usage came from real local logs (see readUsage).
   * Bound to the sender's key by the identity signature when `pubkey` is present.
   */
  readonly verified?: boolean;
  /** Raw ed25519 public key (64 hex) — the persistent identity this hello signs. */
  readonly pubkey?: string;
  /** Random per-hello nonce (hex) covered by the signature. */
  readonly nonce?: string;
  /** ed25519 signature (128 hex) over `handle|league|harness|verified|nonce`. */
  readonly sig?: string;
  /**
   * LOCAL-DERIVED, never on the wire: true when this hello's signature verified
   * against its pubkey (see classifyHelloIdentity). Marked 🔑 in the UI.
   */
  readonly identityVerified?: boolean;
}

/** One-line privacy notice printed before joining the swarm. */
export const LIVE_NOTICE =
  'live discovery: sharing only your handle + league + harness + verified flag + identity pubkey (never raw usage) with same-league peers on the public DHT';

/* Defensive caps so a malicious or buggy peer can't make us retain junk. */
const MAX_HANDLE_LEN = 64;
const MAX_LEAGUE_LEN = 32;
const MAX_HARNESS_LEN = 64;
const MAX_HANDSHAKE_LEN = 4096;

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
    ...(hello.verified !== undefined ? { verified: hello.verified } : {}),
    ...(hello.pubkey !== undefined ? { pubkey: hello.pubkey } : {}),
    ...(hello.nonce !== undefined ? { nonce: hello.nonce } : {}),
    ...(hello.sig !== undefined ? { sig: hello.sig } : {}),
    // identityVerified is LOCAL-derived and deliberately never serialized.
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
  const verified = rec['verified'];
  if (verified !== undefined && typeof verified !== 'boolean') return null;
  // Identity proof: optional (legacy peers), but exactly-shaped hex when present
  // — same discipline as the hello frame. Verification happens one layer up.
  const pubkey = rec['pubkey'];
  if (pubkey !== undefined && (typeof pubkey !== 'string' || !/^[0-9a-fA-F]{64}$/.test(pubkey))) {
    return null;
  }
  const nonce = rec['nonce'];
  if (nonce !== undefined && (typeof nonce !== 'string' || !/^[0-9a-fA-F]{1,64}$/.test(nonce))) {
    return null;
  }
  const sig = rec['sig'];
  if (sig !== undefined && (typeof sig !== 'string' || !/^[0-9a-fA-F]{128}$/.test(sig))) {
    return null;
  }
  return {
    handle,
    league,
    harness:
      typeof harness === 'string' && harness.length > 0 && harness.length <= MAX_HARNESS_LEN
        ? harness
        : 'unknown',
    ...(typeof verified === 'boolean' ? { verified } : {}),
    ...(typeof pubkey === 'string' ? { pubkey } : {}),
    ...(typeof nonce === 'string' ? { nonce } : {}),
    ...(typeof sig === 'string' ? { sig } : {}),
  };
}
