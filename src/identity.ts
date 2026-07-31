/**
 * Persistent ed25519 identity — binds a handle to a keypair so a peer cannot
 * impersonate it.
 *
 * CRYPTO MECHANISM (load/sign/verify ed25519) lives in
 * `@pooriaarab/vibe-core/identity`. The CLAIMS STRING is POLICY and stays LOCAL:
 * {@link canonicalHelloClaims} keeps the long-standing field order
 * `handle|league|harness|verified|nonce` so signatures remain byte-identical
 * with existing peers (and with older identity.json keys).
 *
 * Also LOCAL: the secp256k1 Nostr key (NIP-04 for the relay fallback) — never
 * hoisted; it is a separate curve and product-specific.
 */
import {
  classifyIdentityProof,
  loadOrCreateIdentity as coreLoadOrCreateIdentity,
  signClaimFields,
  verifyClaimFields,
  type Identity,
  type IdentityProof,
  type IdentityVerdict,
} from '@pooriaarab/vibe-core/identity';
import { mkdirSync, chmodSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { defaultStateDir } from './state.js';

export type { Identity, IdentityProof, IdentityVerdict };

/** The hello fields a signature commits to (a PeerHello minus its proof). */
export interface HelloClaims {
  readonly handle: string;
  readonly league: string;
  readonly harness: string;
  readonly verified?: boolean;
}

/**
 * Load the persistent keypair, generating + storing it (mode 0600) on first
 * use. Product state root is POLICY — defaulted here to {@link defaultStateDir}.
 */
export function loadOrCreateIdentity(dir: string = defaultStateDir()): Identity {
  return coreLoadOrCreateIdentity(dir);
}

/**
 * The canonical string an identity signature commits to:
 * `handle|league|harness|verified|nonce` — verified rendered as `true`/`false`.
 * Pure; both sides compute it byte-identically or the signature cannot verify.
 *
 * POLICY — field order stays in vibedating so wire signatures do not change.
 */
export function canonicalHelloClaims(claims: HelloClaims & { nonce: string }): string {
  return [claims.handle, claims.league, claims.harness, String(claims.verified === true), claims.nonce].join(
    '|',
  );
}

/** Ordered claim fields (without nonce) matching {@link canonicalHelloClaims}. */
function helloClaimFields(claims: HelloClaims): readonly (string | boolean)[] {
  // verified is ALWAYS the string true/false via String(claims.verified === true)
  // so a missing flag signs the same as verified: false — long-standing behavior.
  return [claims.handle, claims.league, claims.harness, String(claims.verified === true)];
}

/**
 * Sign hello claims with the persistent identity. A fresh random 16-byte nonce
 * per call (appended as the final `|`-slot by vibe-core), so two hellos never
 * share a signature. Returns only the wire proof fields — the private key stays put.
 */
export function signHelloClaims(identity: Identity, claims: HelloClaims): IdentityProof {
  return signClaimFields(identity, helloClaimFields(claims));
}

/**
 * Verify a claimed proof against hello claims. NEVER throws — any anomaly
 * (bad hex, bad key, bad signature) is simply `false`.
 */
export function verifyHelloClaims(claims: HelloClaims, proof: IdentityProof): boolean {
  return verifyClaimFields(helloClaimFields(claims), proof);
}

/**
 * Classify an incoming hello's identity claim. Pure decision, no IO — the
 * caller (discovery) turns 'drop' into "never recorded, never paired".
 */
export function classifyHelloIdentity(hello: HelloClaims & Partial<IdentityProof>): IdentityVerdict {
  return classifyIdentityProof(hello, (proof) => verifyHelloClaims(hello, proof));
}

/* -------------------------------------------------------------------------- */
/* Persistent Nostr (secp256k1) key — for the relay fallback's NIP-04 e2e.    */
/* -------------------------------------------------------------------------- */

/**
 * A separate secp256k1 keypair for the Nostr relay fallback (see relay.ts).
 * Kept DISTINCT from the ed25519 {@link Identity} on purpose: NIP-04 encryption
 * requires a secp256k1 key, and reusing or deriving the ed25519 key for that
 * would cross two unrelated cryptographic curves. The private key is persisted
 * at `<dir>/nostr.json` (mode 0600) and never leaves the file; only the
 * secp256k1 public key (hex) is ever published on a relay.
 */
export interface NostrKey {
  /** 32-byte secp256k1 secret key — the NIP-04 decrypt/encrypt key. Never sent. */
  readonly sk: Uint8Array;
  /** secp256k1 public key, hex (64 chars) — safe to publish; the relay sees it. */
  readonly pubkey: string;
}

/** The file under the state dir holding the persistent Nostr secp256k1 key (0600). */
const NOSTR_FILE = 'nostr.json';

function nostrPath(dir: string): string {
  return path.join(dir, NOSTR_FILE);
}

function isStoredNostrKey(
  data: unknown,
): data is { sk: string; pubkey: string; createdAt: string } {
  if (typeof data !== 'object' || data === null) return false;
  const r = data as Record<string, unknown>;
  return (
    typeof r['sk'] === 'string' &&
    /^[0-9a-f]{64}$/.test(r['sk']) &&
    typeof r['pubkey'] === 'string' &&
    /^[0-9a-f]{64}$/.test(r['pubkey']) &&
    typeof r['createdAt'] === 'string'
  );
}

/**
 * Load the persistent secp256k1 Nostr key, generating + storing it (mode 0600)
 * on first use. A missing or corrupt file is (re)generated — never throws on
 * disk content. Idempotent across runs: same file → same key. `nostr-tools` is
 * imported LAZILY (only when a key must be generated) so non-relay commands
 * never pay for the secp256k1 stack.
 */
export async function loadOrCreateNostrKey(dir: string = defaultStateDir()): Promise<NostrKey> {
  // The persisted file is the common case (already generated) — read it without
  // touching nostr-tools so existing relayers stay fast.
  try {
    const raw = readFileSync(nostrPath(dir), 'utf8');
    const data: unknown = JSON.parse(raw);
    if (isStoredNostrKey(data)) {
      try {
        chmodSync(nostrPath(dir), 0o600);
      } catch {
        /* best-effort mode hardening on read */
      }
      return { sk: Buffer.from(data.sk, 'hex'), pubkey: data.pubkey };
    }
  } catch {
    /* missing or corrupt — fall through and (re)generate */
  }
  // Lazy import: only the first relay use (or a corrupt file) loads nostr-tools.
  const { generateSecretKey, getPublicKey } = await import('nostr-tools');
  const sk = generateSecretKey();
  const pubkey = getPublicKey(sk);
  const skHex = Buffer.from(sk).toString('hex');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    nostrPath(dir),
    JSON.stringify({ sk: skHex, pubkey, createdAt: new Date().toISOString() }, null, 2) + '\n',
    { encoding: 'utf8', mode: 0o600 },
  );
  // mode on write applies only to new files — force it for a pre-existing one.
  try {
    chmodSync(nostrPath(dir), 0o600);
  } catch {
    /* best-effort hardening; the file content is still valid */
  }
  return { sk, pubkey };
}
