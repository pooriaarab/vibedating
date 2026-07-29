/**
 * Nostr-relay FALLBACK transport — when direct hyperdht hole-punching fails
 * (symmetric NAT on either side), route e2e-encrypted chat through PUBLIC Nostr
 * relays (the public commons — we host nothing).
 *
 * Two vibedate peers rendezvous on a conversation tag derived DETERMINISTICALLY
 * from BOTH of their ed25519 identity pubkeys (sorted + sha256'd). Each peer
 * joins that tag on a configurable set of public relays and exchanges NIP-04
 * encrypted DMs. The relay stores only ciphertext — it cannot read the
 * conversation. A Nostr-specific secp256k1 key (see identity.ts
 * {@link loadOrCreateNostrKey}) is generated + persisted SEPARATELY from the
 * ed25519 identity; the two curves are never mixed.
 *
 * Transport seam: all relay I/O goes through {@link RelayTransport}. The real
 * implementation ({@link createNostrPoolTransport}) wraps `nostr-tools`'s
 * `SimplePool` over wss://; tests inject an in-memory fan-out instead (no real
 * WebSocket, no network). `nostr-tools` itself is imported LAZILY so non-relay
 * commands (`connect`, `matches`, `mcp`, …) never pay for the secp256k1 stack.
 *
 * Rendezvous + e2e at a glance:
 *   1. convTag = sha256('vibedate:nostr:' + min(edA,edB) + ':' + max(edA,edB))
 *   2. each side subscribes to { '#t': [convTag] } on the relay(s);
 *   3. each side publishes a PRESENCE event on the tag carrying its own ed25519
 *      (a tag) so the peer can bind the sender's nostr pubkey to the expected
 *      identity — this is the bootstrap that lets either side learn the other's
 *      secp256k1 pubkey (Nostr `event.pubkey`) for NIP-04;
 *   4. messages are kind-4 NIP-04 sealed DMs (ciphertext), tagged with the
 *      convTag + the recipient pubkey; only the intended recipient can decrypt.
 */
import { createHash } from 'node:crypto';
import type { PeerLink } from './link.js';
import type { RtcFrame } from './frame.js';
import type { ReceivedMedia } from './media.js';
import type { PeerHello } from './p2p.js';

/* -------------------------------------------------------------------------- */
/* Relay transport seam                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A Nostr event, reduced to the fields this module touches. Structurally
 * compatible with `nostr-tools`'s `Event`, so a finalized/verified event can be
 * published and a relay-delivered event can be received without conversion.
 */
export interface RelayEvent {
  readonly kind: number;
  /** Sender's secp256k1 (Nostr) pubkey, hex — public; the relay sees it. */
  readonly pubkey: string;
  /** Ciphertext for kind-4 DMs; a presence marker for the presence kind. */
  readonly content: string;
  readonly tags: readonly (readonly string[])[];
  readonly created_at: number;
  readonly id: string;
  readonly sig: string;
}

/** A subscription filter: kinds + a `#t` conversation-tag match. */
export interface RelayFilter {
  readonly kinds?: readonly number[];
  readonly '#t'?: readonly string[];
}

/**
 * The injection point between the relay link and the wire. The production
 * implementation is {@link createNostrPoolTransport} (real wss:// relays via
 * `nostr-tools` `SimplePool`); tests pass an in-memory fan-out. A real relay
 * STORES events and replays matching stored events to new subscribers (that
 * store-and-replay semantics is what makes the presence handshake work across
 * arrival order) — a faithful mock must do the same.
 */
export interface RelayTransport {
  /** Publish a signed event to the relay(s). Fire-and-forget / best-effort. */
  publish(event: RelayEvent): void;
  /**
   * Subscribe to events matching `filter`. Returns an unsubscribe. A faithful
   * relay replays matching STORED events to a brand-new subscriber before any
   * future ones, so the presence handshake is order-independent.
   */
  subscribe(filter: RelayFilter, onEvent: (event: RelayEvent) => void): () => void;
  /** Close all relay connections. Idempotent. */
  close(): void;
}

/* -------------------------------------------------------------------------- */
/* Defaults + rendezvous                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Default public Nostr relays (the public commons — we host none of them).
 * Overridable via {@link createNostrPoolTransport}. These are well-known,
 * generally-open relays; any reachable public relay works.
 */
export const DEFAULT_RELAYS: readonly string[] = [
  'wss://relay.damus.io',
  'wss://nostr.mom',
  'wss://relay.snort.social',
];

/** Kind for encrypted DM payloads — the standard NIP-04 sealed-direct-message kind. */
export const VIBEDATE_MESSAGE_KIND = 4;
/**
 * Kind for the presence/rendezvous ping (parameterized-replaceable range). Its
 * content is a constant marker that reveals nothing about the conversation; its
 * `event.pubkey` is the sender's Nostr key (public by definition), and an
 * `ed25519` tag binds it to the sender's identity so the receiver only accepts
 * presence from the peer it expects.
 */
export const VIBEDATE_PRESENCE_KIND = 30078;
/** The `d` tag (replaceable-key) for a presence event — one latest presence per peer. */
const PRESENCE_D_TAG = 'vibedating';
/** Constant presence payload — carries no conversation data (not the chat text). */
const PRESENCE_MARKER = JSON.stringify({ app: 'vibedating', v: 1 });
/** Tag name carrying the sender's ed25519 identity pubkey (hex) on a relay event. */
const ED25519_TAG = 'ed25519';

/**
 * Derive the deterministic conversation tag two peers rendezvous on, from BOTH
 * ed25519 identity pubkeys (sorted, hashed). Pure: both sides compute it
 * byte-identically from data each already holds (their own identity + the
 * peer's advertised pubkey), so NO extra exchange is needed to agree on the
 * rendezvous point. The hash hides the underlying identities from anyone
 * scanning the relay by tag.
 */
export function conversationTag(myEd25519Hex: string, peerEd25519Hex: string): string {
  const lo = myEd25519Hex < peerEd25519Hex ? myEd25519Hex : peerEd25519Hex;
  const hi = myEd25519Hex < peerEd25519Hex ? peerEd25519Hex : myEd25519Hex;
  return createHash('sha256').update(`vibedate:nostr:${lo}:${hi}`, 'utf8').digest('hex');
}

/* -------------------------------------------------------------------------- */
/* Lazy nostr-tools loader                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Cached lazy import of `nostr-tools`. Resolved once, on first relay use, so
 * `connect`/`matches`/`mcp` and the whole non-relay CLI never load the
 * secp256k1/WebSocket stack.
 */
let nostrPromise: Promise<typeof import('nostr-tools')> | undefined;
function nostr(): Promise<typeof import('nostr-tools')> {
  if (!nostrPromise) nostrPromise = import('nostr-tools');
  return nostrPromise;
}

/* -------------------------------------------------------------------------- */
/* NostrRelayLink                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A relay-fallback link with the SAME shape as {@link PeerLink}, so callers can
 * drop it in wherever a direct P2P link is used (pairing, the `live` chat loop).
 *
 * Implemented in v0: `send`/`onMessage`/`onClose`/`close` + `.hello` (text chat
 * over NIP-04). `sendMedia`/`sendSignal`/`onMedia`/`onSignal` are accepted as
 * no-ops so the link is type-interchangeable with a direct PeerLink — chunked
 * media + WebRTC signaling over the relay are `// ponytail:` follow-ups (a relay
 * link is a fallback for peers who can't connect at all, where plain text chat
 * is the priority).
 */
export type NostrRelayLink = PeerLink;

/** Options for {@link createNostrRelayLink}. */
export interface CreateNostrRelayLinkOptions {
  /** This peer's Nostr secp256k1 keypair (see {@link loadOrCreateNostrKey}). */
  readonly myNostr: { readonly sk: Uint8Array; readonly pubkey: string };
  /** This peer's ed25519 identity pubkey (hex) — half of the convTag input. */
  readonly myEd25519Hex: string;
  /** The REMOTE peer's ed25519 identity pubkey (hex) — the other convTag half. */
  readonly peerEd25519Hex: string;
  /** The remote peer's identity, surfaced as the link's `.hello`. */
  readonly hello: PeerHello;
  /** The injected relay transport (real pool OR an in-memory mock). */
  readonly transport: RelayTransport;
}

/** Read the first value of a named tag from an event, or `undefined`. */
function tagValue(event: RelayEvent, name: string): string | undefined {
  for (const tag of event.tags) {
    if (tag[0] === name && typeof tag[1] === 'string') return tag[1];
  }
  return undefined;
}

/**
 * Build a {@link NostrRelayLink} over the injected {@link RelayTransport}. The
 * link immediately subscribes to the conversation tag and publishes its presence
 * so the peer can learn this side's Nostr pubkey (the bootstrap for NIP-04).
 * Resolves once subscribed + presence published. Async only because
 * `nostr-tools` (NIP-04 + event signing) is lazy-imported on first use.
 */
export async function createNostrRelayLink(
  opts: CreateNostrRelayLinkOptions,
): Promise<NostrRelayLink> {
  const { finalizeEvent, nip04 } = await nostr();
  const { myNostr, myEd25519Hex, peerEd25519Hex, hello, transport } = opts;
  const convTag = conversationTag(myEd25519Hex, peerEd25519Hex);

  const messageCbs = new Set<(m: { id: string; text: string; at: number }) => void>();
  const closeCbs = new Set<() => void>();
  // Accepted for PeerLink-shape interchange; never invoked in v0 (ponytail).
  const mediaCbs = new Set<(m: ReceivedMedia) => void>();
  const signalCbs = new Set<(f: RtcFrame) => void>();

  let closed = false;
  /** The peer's Nostr pubkey, learned from their presence (bootstrap). */
  let peerNostrPubkey: string | undefined;
  /** Messages sent before we learned the peer's pubkey; flushed on presence. */
  const pending: string[] = [];

  /** Publish a signed event (fire-and-forget); never throws up the stack. */
  const publish = (template: {
    kind: number;
    content: string;
    tags: string[][];
  }): void => {
    let event: RelayEvent;
    try {
      event = finalizeEvent(
        { ...template, created_at: Math.floor(Date.now() / 1000) },
        myNostr.sk,
      ) as unknown as RelayEvent;
    } catch {
      return; // signing failure (e.g. bad key) — nothing to send
    }
    try {
      transport.publish(event);
    } catch {
      /* transport gone — best-effort */
    }
  };

  /** Announce our presence so the peer can learn our Nostr pubkey. */
  const publishPresence = (): void => {
    publish({
      kind: VIBEDATE_PRESENCE_KIND,
      content: PRESENCE_MARKER,
      tags: [
        ['d', PRESENCE_D_TAG],
        ['t', convTag],
        [ED25519_TAG, myEd25519Hex],
      ],
    });
  };

  /** Encrypt + publish one NIP-04 sealed DM to the peer. */
  const sendEncrypted = (text: string, recipientPubkey: string): void => {
    let ciphertext: string;
    try {
      ciphertext = nip04.encrypt(myNostr.sk, recipientPubkey, text);
    } catch {
      return; // encrypt failure — drop, never send plaintext
    }
    publish({
      kind: VIBEDATE_MESSAGE_KIND,
      content: ciphertext,
      tags: [
        ['t', convTag],
        ['p', recipientPubkey],
        [ED25519_TAG, myEd25519Hex],
      ],
    });
  };

  /** Flush any messages queued before the peer's pubkey was known. */
  const flushPending = (): void => {
    if (peerNostrPubkey === undefined) return;
    while (pending.length > 0) {
      const text = pending.shift();
      if (text !== undefined) sendEncrypted(text, peerNostrPubkey);
    }
  };

  // Subscribe BEFORE publishing presence so we catch the peer's presence even if
  // it arrived earlier (a faithful relay replays stored events to new subs).
  const unsubscribe = transport.subscribe({ '#t': [convTag] }, (event) => {
    if (closed) return;
    if (event.pubkey === myNostr.pubkey) return; // ignore our own echo
    if (event.kind === VIBEDATE_PRESENCE_KIND) {
      // Bind: only accept presence claiming OUR expected peer's ed25519, so a
      // third party publishing on the same tag can't hijack the peer slot.
      const claimedEd = tagValue(event, ED25519_TAG);
      if (claimedEd !== peerEd25519Hex) return;
      peerNostrPubkey = event.pubkey;
      flushPending();
      return;
    }
    if (event.kind === VIBEDATE_MESSAGE_KIND) {
      // Only the holder of the peer's Nostr secret can have produced a payload
      // that decrypts with our key + their pubkey. A decrypt failure means the
      // event was not sealed to us (e.g. the peer sealed it to someone else, or
      // a third party is injecting) — drop it, never surface garbage.
      let plaintext: string;
      try {
        const sender = peerNostrPubkey ?? event.pubkey;
        plaintext = nip04.decrypt(myNostr.sk, sender, event.content);
      } catch {
        return; // not for us / corrupt ciphertext — drop silently
      }
      // Receiving a decryptable message also pins the peer's pubkey, in case
      // their presence event never reached us on this relay.
      peerNostrPubkey = event.pubkey;
      const msg = { id: event.id, text: plaintext, at: event.created_at * 1000 };
      for (const cb of messageCbs) cb(msg);
      return;
    }
    // Unknown kinds on our tag — ignore.
  });

  // Announce ourselves so the peer can bootstrap NIP-04 to us.
  publishPresence();

  return {
    hello,
    get closed() { return closed; },
    send(text) {
      if (closed) return;
      if (peerNostrPubkey === undefined) {
        pending.push(text); // peer pubkey unknown yet — queue until presence lands
        return;
      }
      sendEncrypted(text, peerNostrPubkey);
    },
    // ponytail: chunked media over the relay (mirror link.ts media frames as
    // kind-4 payloads). For v0 a relay link carries text only.
    async sendMedia() {
      return { id: '', size: 0 };
    },
    // ponytail: relay WebRTC signaling (rtc-offer/answer/ice as kind-4 payloads)
    // so A/V could also fall back through the relay. v0: text only.
    sendSignal() {
      /* no-op in v0 */
    },
    onMessage(cb) {
      messageCbs.add(cb);
    },
    onMedia(cb) {
      mediaCbs.add(cb);
    },
    onSignal(cb) {
      signalCbs.add(cb);
    },
    onClose(cb) {
      closeCbs.add(cb);
    },
    close() {
      if (closed) return;
      closed = true;
      // A locally-initiated close does NOT re-fire our own onClose callbacks
      // (mirrors PeerLink semantics); remote close paths aren't modeled over a
      // relay in v0 (there is no socket 'end').
      try {
        unsubscribe();
      } catch {
        /* already unsubscribed */
      }
      try {
        transport.close();
      } catch {
        /* transport already gone */
      }
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Real transport — nostr-tools SimplePool over wss://                        */
/* -------------------------------------------------------------------------- */

/**
 * Build a real {@link RelayTransport} over public Nostr relays via
 * `nostr-tools`'s `SimplePool`. `nostr-tools` (and its WebSocket stack) is
 * imported lazily here. Async because constructing the pool may need the
 * lazy module load. The returned transport:
 *   - `publish` is fire-and-forget (publishes to all relays, awaits none);
 *   - `subscribe` mirrors `SimplePool.subscribeMany` and returns an unsub;
 *   - `close` tears the pool down.
 */
export async function createNostrPoolTransport(
  urls: readonly string[] = DEFAULT_RELAYS,
): Promise<RelayTransport> {
  const { SimplePool } = await nostr();
  const pool = new SimplePool();
  const relays = [...urls];
  return {
    publish(event) {
      // Best-effort: deliver to as many relays as will take it. Await nothing —
      // a relay link must not block the chat loop on a slow/half-open socket.
      try {
        const results = pool.publish(relays, event as unknown as import('nostr-tools').Event);
        Promise.allSettled(results).catch(() => {
          /* every relay rejected — the message just won't route */
        });
      } catch {
        /* pool/relay gone — best-effort */
      }
    },
    subscribe(filter, onEvent) {
      const closer = pool.subscribeMany(
        relays,
        filter as unknown as import('nostr-tools').Filter,
        { onevent: (e) => onEvent(e as unknown as RelayEvent) },
      );
      return () => {
        try {
          closer.close();
        } catch {
          /* already closed */
        }
      };
    },
    close() {
      try {
        pool.close(relays);
      } catch {
        /* already gone */
      }
      try {
        pool.destroy();
      } catch {
        /* already destroyed */
      }
    },
  };
}
