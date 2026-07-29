/**
 * Nostr-relay fallback — e2e exchange + third-party-opaqueness over an in-memory
 * relay. No real WebSocket, no network: a faithful mock relay (stores events and
 * replays matching stored events to new subscribers, exactly like a real relay)
 * stands in for the wss:// commons.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey, nip04 } from 'nostr-tools';
import type { PeerHello } from './p2p.js';
import type { PeerLink } from './link.js';
import {
  conversationTag,
  createNostrRelayLink,
  VIBEDATE_MESSAGE_KIND,
  VIBEDATE_PRESENCE_KIND,
  type RelayEvent,
  type RelayFilter,
  type RelayTransport,
} from './relay.js';

const helloA: PeerHello = { handle: '@alice', league: '10M', harness: 'claude-code' };
const helloB: PeerHello = { handle: '@bob', league: '10M', harness: 'codex' };

/**
 * In-memory relay: stores every published event and replays matching stored
 * events to a brand-new subscriber (the store-and-replay semantics a real relay
 * has), then fans future publishes to matching subscribers. Faithful enough that
 * the presence handshake works regardless of which link subscribes first.
 */
class InMemoryRelay implements RelayTransport {
  private readonly events: RelayEvent[] = [];
  private readonly subs = new Set<{ filter: RelayFilter; cb: (e: RelayEvent) => void }>();

  publish(event: RelayEvent): void {
    this.events.push(event);
    // Async fan-out, like a real relay over a socket: a published event is
    // delivered on a later turn, so callers can wire onMessage AFTER creating
    // a link and still receive the first message (the queue-flush path relies
    // on this). Stored synchronously so a brand-new subscriber still replays it.
    queueMicrotask(() => {
      for (const s of [...this.subs]) {
        if (matches(s.filter, event)) s.cb(event);
      }
    });
  }

  subscribe(filter: RelayFilter, cb: (e: RelayEvent) => void): () => void {
    const s = { filter, cb };
    this.subs.add(s);
    // Replay matching STORED events SYNCHRONOUSLY so the presence bootstrap is
    // deterministic regardless of which link subscribes first.
    for (const e of this.events) if (matches(filter, e)) cb(e);
    return () => {
      this.subs.delete(s);
    };
  }

  close(): void {
    this.subs.clear();
  }
}

/** Minimal Nostr filter match: `kinds` + a `#t` conversation-tag. */
function matches(filter: RelayFilter, event: RelayEvent): boolean {
  if (filter.kinds !== undefined && !filter.kinds.includes(event.kind)) return false;
  if (filter['#t'] !== undefined) {
    const want = filter['#t'];
    const has = event.tags.some(
      (t) => t[0] === 't' && typeof t[1] === 'string' && want.includes(t[1]),
    );
    if (!has) return false;
  }
  return true;
}

/** One fresh secp256k1 Nostr keypair + a fresh ed25519 hex identity stand-in. */
function freshKey(): { sk: Uint8Array; pubkey: string } {
  const sk = generateSecretKey();
  return { sk, pubkey: getPublicKey(sk) };
}
const freshEd = (): string => randomBytes(32).toString('hex');

/** Drain the microtask queue so the mock relay's async fan-out lands. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** A pair of cross-wired relay links over one in-memory relay. */
interface Pair {
  readonly relay: InMemoryRelay;
  readonly linkA: PeerLink;
  readonly linkB: PeerLink;
  readonly a: { sk: Uint8Array; pubkey: string; ed: string };
  readonly b: { sk: Uint8Array; pubkey: string; ed: string };
}

async function makePair(): Promise<Pair> {
  const relay = new InMemoryRelay();
  const a = { ...freshKey(), ed: freshEd() };
  const b = { ...freshKey(), ed: freshEd() };
  // A's link represents the connection TO B → A's `.hello` is B's identity.
  const linkA = await createNostrRelayLink({
    myNostr: a,
    myEd25519Hex: a.ed,
    peerEd25519Hex: b.ed,
    hello: helloB,
    transport: relay,
  });
  const linkB = await createNostrRelayLink({
    myNostr: b,
    myEd25519Hex: b.ed,
    peerEd25519Hex: a.ed,
    hello: helloA,
    transport: relay,
  });
  return { relay, linkA, linkB, a, b };
}

describe('conversationTag — rendezvous from both identity pubkeys', () => {
  it('is symmetric (order-independent) — both peers compute the same tag', () => {
    const edA = freshEd();
    const edB = freshEd();
    expect(conversationTag(edA, edB)).toBe(conversationTag(edB, edA));
  });

  it('is deterministic — same pair always hashes to the same tag', () => {
    const edA = freshEd();
    const edB = freshEd();
    expect(conversationTag(edA, edB)).toBe(conversationTag(edA, edB));
  });

  it('is a 64-hex sha256 digest', () => {
    expect(conversationTag(freshEd(), freshEd())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs for a different peer pair (so conversations do not collide)', () => {
    const edA = freshEd();
    const edB = freshEd();
    const edC = freshEd();
    expect(conversationTag(edA, edB)).not.toBe(conversationTag(edA, edC));
  });
});

describe('NostrRelayLink — e2e exchange over the mock relay', () => {
  it('delivers a sent message to the remote onMessage, e2e (NIP-04)', async () => {
    const { linkA, linkB } = await makePair();
    const got = jestLikeCollector();
    linkB.onMessage(got.push);

    linkA.send('hey bob');
    await tick();

    expect(got.msgs.length).toBe(1);
    expect(got.msgs[0]!.text).toBe('hey bob');
    expect(typeof got.msgs[0]!.id).toBe('string');
    expect(got.msgs[0]!.id.length).toBeGreaterThan(0);
    expect(typeof got.msgs[0]!.at).toBe('number');
  });

  it('exchanges text both ways over one relay', async () => {
    const { linkA, linkB } = await makePair();
    const gotA = jestLikeCollector();
    const gotB = jestLikeCollector();
    linkA.onMessage(gotA.push);
    linkB.onMessage(gotB.push);

    linkA.send('to B');
    linkB.send('to A');
    await tick();

    expect(gotB.msgs.map((m) => m.text)).toEqual(['to B']);
    expect(gotA.msgs.map((m) => m.text)).toEqual(['to A']);
  });

  it('queues a message sent before the peer is known, delivers on presence', async () => {
    // Build A first, send BEFORE B exists (so B's presence hasn't arrived → the
    // message is queued). Creating B replays A's presence to B and fans B's
    // presence back to A, which flushes the queued message to B.
    const relay = new InMemoryRelay();
    const a = { ...freshKey(), ed: freshEd() };
    const b = { ...freshKey(), ed: freshEd() };
    const linkA = await createNostrRelayLink({
      myNostr: a,
      myEd25519Hex: a.ed,
      peerEd25519Hex: b.ed,
      hello: helloB,
      transport: relay,
    });
    const gotB = jestLikeCollector();
    let linkB!: PeerLink;
    // Send while B is totally absent — must be queued, not dropped.
    linkA.send('queued until you arrive');

    linkB = await createNostrRelayLink({
      myNostr: b,
      myEd25519Hex: b.ed,
      peerEd25519Hex: a.ed,
      hello: helloA,
      transport: relay,
    });
    linkB.onMessage(gotB.push);
    await tick();

    expect(gotB.msgs.map((m) => m.text)).toEqual(['queued until you arrive']);
  });

  it('exposes the peer hello it was built with', async () => {
    const { linkA } = await makePair();
    expect(linkA.hello).toEqual(helloB);
  });

  it('satisfies the PeerLink shape (interchangeable with a direct link)', async () => {
    const { linkA } = await makePair();
    const link: PeerLink = linkA; // type-level: assignable
    for (const m of ['send', 'sendMedia', 'sendSignal', 'onMessage', 'onMedia', 'onSignal', 'onClose', 'close'] as const) {
      expect(typeof link[m]).toBe('function');
    }
    // v0 media are no-ops but must not throw.
    expect(await link.sendMedia('/no/such/file')).toEqual({ id: '', size: 0 });
    expect(() => link.sendSignal({ t: 'rtc-offer', sdp: 'x' })).not.toThrow();
  });

  it('relays WebRTC signaling separately from text messages', async () => {
    const { linkA, linkB } = await makePair();
    const gotBMsgs = jestLikeCollector();
    const gotBSignals: import('./frame.js').RtcFrame[] = [];
    linkB.onMessage(gotBMsgs.push);
    linkB.onSignal((f) => gotBSignals.push(f));

    const offer: import('./frame.js').RtcFrame = { t: 'rtc-offer', sdp: 'fake-sdp' };
    linkA.sendSignal(offer);
    linkA.send('plain text');
    await tick();

    expect(gotBSignals.length).toBe(1);
    expect(gotBSignals[0]).toEqual(offer);
    expect(gotBMsgs.msgs.length).toBe(1);
    expect(gotBMsgs.msgs[0]!.text).toBe('plain text');
  });

  it('never sends plaintext on the wire — relay events carry ciphertext only', async () => {
    const relay = new InMemoryRelay();
    const seen: RelayEvent[] = [];
    // A raw observer on the same relay sees every event the relay stores.
    const observing: RelayTransport = {
      publish: (e) => {
        seen.push(e);
        relay.publish(e);
      },
      subscribe: (f, cb) => relay.subscribe(f, cb),
      close: () => relay.close(),
    };
    const a = { ...freshKey(), ed: freshEd() };
    const b = { ...freshKey(), ed: freshEd() };
    const linkA = await createNostrRelayLink({
      myNostr: a,
      myEd25519Hex: a.ed,
      peerEd25519Hex: b.ed,
      hello: helloB,
      transport: observing,
    });
    await createNostrRelayLink({
      myNostr: b,
      myEd25519Hex: b.ed,
      peerEd25519Hex: a.ed,
      hello: helloA,
      transport: observing,
    });

    const secret = 'plaintext-must-never-leave-the-link';
    linkA.send(secret);
    await tick();

    const messages = seen.filter((e) => e.kind === VIBEDATE_MESSAGE_KIND);
    expect(messages.length).toBe(1);
    // The relay only ever saw ciphertext — never the secret itself.
    expect(messages[0]!.content).not.toContain(secret);
    // Presence carries only a constant marker, not conversation text.
    const presence = seen.filter((e) => e.kind === VIBEDATE_PRESENCE_KIND);
    expect(presence.length).toBeGreaterThan(0);
    for (const p of presence) expect(p.content).not.toContain(secret);
  });
});

describe('NostrRelayLink — a third party CANNOT read the plaintext', () => {
  it('a different secp256k1 key cannot NIP-04-decrypt a captured ciphertext', async () => {
    const { relay, linkA, a } = await makePair();

    // Capture every kind-4 ciphertext the relay stores for this conversation.
    const captured: string[] = [];
    relay.subscribe({ kinds: [VIBEDATE_MESSAGE_KIND] }, (e) => captured.push(e.content));

    const secret = 'only the intended recipient can read this';
    linkA.send(secret);
    await tick();
    expect(captured.length).toBe(1);

    // A third party (its own key) intercepts the ciphertext off the relay and
    // tries to decrypt with ECDH(thirdKey, senderPubkey) — the derived AES key
    // is wrong, so NIP-04 decryption must fail (or yield garbage), never the
    // secret. This is the core end-to-end-encryption guarantee: the relay
    // (or any relay operator) cannot read the conversation it stores.
    const third = freshKey();
    let recovered: string | undefined;
    try {
      recovered = nip04.decrypt(third.sk, a.pubkey, captured[0]!);
    } catch {
      recovered = undefined; // AES-CBC padding mismatch → throws
    }
    expect(recovered).not.toBe(secret);
  });

  it('conversations are tag-isolated: a different peer pair never sees this traffic', async () => {
    const { relay, linkA, linkB } = await makePair();
    const gotB = jestLikeCollector();
    linkB.onMessage(gotB.push);

    // C is a relay link for a WHOLLY DIFFERENT conversation (a fourth party D):
    // its conversation tag is conversationTag(edC, edD) ≠ conversationTag(edA, edB),
    // so it must never receive A↔B traffic on the shared relay.
    const c = { ...freshKey(), ed: freshEd() };
    const d = { ...freshKey(), ed: freshEd() };
    const gotC = jestLikeCollector();
    const linkC = await createNostrRelayLink({
      myNostr: c,
      myEd25519Hex: c.ed,
      peerEd25519Hex: d.ed,
      hello: helloA,
      transport: relay,
    });
    linkC.onMessage(gotC.push);

    const secret = 'B-only secret';
    linkA.send(secret);
    await tick();

    expect(gotB.msgs.map((m) => m.text)).toContain(secret);
    expect(gotC.msgs.length).toBe(0); // different tag → nothing routed to C
  });
});

/** Tiny vitest-free message collector so this file stays dependency-light. */
function jestLikeCollector(): {
  push: (m: { id: string; text: string; at: number }) => void;
  msgs: { id: string; text: string; at: number }[];
} {
  const msgs: { id: string; text: string; at: number }[] = [];
  return { push: (m) => msgs.push(m), msgs };
}
