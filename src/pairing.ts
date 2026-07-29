/**
 * Pairing policy for the live layer — pure, over an injected set of links.
 *
 * Two modes share one policy object:
 *
 *   - Omegle: links arrive (`add`) and are auto-paired one at a time; `next()`
 *     closes the current match and rolls to the next waiting link (or idles).
 *   - Dating: `open(handle)` picks the specific waiting link whose peer
 *     advertised that handle, closing any current match first.
 *
 * This module knows nothing about hyperswarm, the DHT, or the wire — it only
 * shuffles {@link PeerLink}s handed to it. That keeps it trivially unit-testable
 * with fakes and keeps the policy out of the transport.
 *
 * Remote hang-ups are handled too: when the matched peer "next"s us, the link's
 * onClose fires and we auto-pair the next waiting link (omegle stays live).
 *
 * MESSAGE ROUTING (the correctness bit): `onMessage` is bound ONCE per link in
 * {@link LivePairing.add} — never re-bound on match. A message from the current
 * peer is delivered live; a message from a NON-current (queued) peer is BUFFERED
 * (never dropped) and a queued-count notice fires, then flushed when that peer
 * becomes current. Binding once per link means there is exactly one handler per
 * link: no accumulation (no duplicate delivery) and no silent drops.
 */
import type { PeerLink } from './link.js';

/** A chat message received from a peer. Mirrors PeerLink.onMessage's payload. */
export interface IncomingMessage {
  readonly id: string;
  readonly text: string;
  readonly at: number;
}

/**
 * A drained message tagged with its sender's handle — for PULL-based consumers
 * (the MCP `live_poll` tool) that read every inbound message since the last
 * poll, current or queued, without registering a push callback.
 */
export interface PairingMessage {
  readonly from: string;
  readonly id: string;
  readonly text: string;
  readonly at: number;
  /** True if this arrived from a NON-current (queued) peer at receive time. */
  readonly queued: boolean;
}

export interface LivePairing {
  /** Number of unmatched links waiting in the queue. */
  readonly available: number;
  /** The currently-matched link, or `undefined` when idle. */
  current(): PeerLink | undefined;
  /**
   * Omegle "next": close the current match and advance to the next waiting link
   * (auto-pair), or go idle if the queue is empty. Returns the new current link.
   */
  next(): PeerLink | undefined;
  /**
   * Dating pick: match the available link whose `hello.handle === handle`.
   * Closes the current match first. Returns the matched link, or `undefined`.
   */
  open(handle: string): PeerLink | undefined;
  /** Add a newly-arrived link (fed from discovery's `onLink`). Auto-pairs if idle. */
  add(link: PeerLink): void;
  /** Register a callback fired whenever the current match changes (incl. → idle). */
  onMatch(cb: (link: PeerLink | undefined) => void): void;
  /**
   * Register a callback fired for each message from the CURRENT peer — including
   * buffered messages flushed when a peer becomes current. `from` is the sender's
   * handle. Registered on the pairing (not per-link), so callers NEVER bind
   * `link.onMessage` themselves.
   */
  onMessage(cb: (from: string, m: IncomingMessage) => void): void;
  /**
   * Register a callback fired when a NON-current (queued) peer sends a message —
   * it is buffered, not dropped. `queued` is that peer's current buffered count.
   */
  onQueued(cb: (from: string, queued: number) => void): void;
  /**
   * Pull every inbound message received since the last drain (current + queued),
   * tagged with sender; empties the buffer. For PULL consumers (MCP live_poll).
   */
  drain(): PairingMessage[];
  /** Snapshot of the currently-queued (non-current) links. */
  queued(): PeerLink[];
}

/** ponytail: per-peer buffer cap; oldest dropped beyond it (bound memory). */
const MAX_BUFFERED = 100;

/** Hard cap on waiting links. Oldest dropped if exceeded. */
const MAX_QUEUE = 100;

/** Construct an empty pairing policy. */
export function createPairing(): LivePairing {
  const queue: PeerLink[] = [];
  const matchCbs = new Set<(link: PeerLink | undefined) => void>();
  const msgCbs = new Set<(from: string, m: IncomingMessage) => void>();
  const queuedCbs = new Set<(from: string, queued: number) => void>();
  const buffers = new Map<PeerLink, IncomingMessage[]>();
  const drainBuffer: PairingMessage[] = [];
  let current: PeerLink | undefined;

  const emitMatch = (link: PeerLink | undefined): void => {
    for (const cb of matchCbs) cb(link);
  };
  const deliver = (from: string, m: IncomingMessage): void => {
    for (const cb of msgCbs) cb(from, m);
  };
  const notifyQueued = (from: string, n: number): void => {
    for (const cb of queuedCbs) cb(from, n);
  };

  /** Flush any messages buffered while this link was NOT current. */
  const flush = (link: PeerLink): void => {
    const buf = buffers.get(link);
    if (buf !== undefined && buf.length > 0) {
      for (const m of buf) deliver(link.hello.handle, m);
      buffers.set(link, []);
    }
  };

  /** Make `link` (or undefined) the current match: flush its buffer + notify. */
  const setCurrent = (link: PeerLink | undefined): void => {
    current = link;
    if (link !== undefined) flush(link);
    emitMatch(link);
  };

  /**
   * Watch a link for a REMOTE hang-up. PeerLink only fires onClose on a remote
   * bye/end/error — a LOCAL close() (our own `next()`) never triggers this, so
   * there is no double-advance hazard.
   */
  const watch = (link: PeerLink): void => {
    link.onClose(() => {
      buffers.delete(link);
      if (current === link) {
        let nextUp: PeerLink | undefined;
        while (queue.length > 0) {
          const cand = queue.shift()!;
          if (!cand.closed) {
            nextUp = cand;
            break;
          }
        }
        setCurrent(nextUp); // may be undefined → idle
      } else {
        const idx = queue.indexOf(link);
        if (idx >= 0) queue.splice(idx, 1);
      }
    });
  };

  /**
   * Bind onMessage ONCE, when the link is created (the fix). Current peer →
   * delivered live; non-current peer → buffered + a queued notice. Exactly one
   * handler per link: no accumulation, no drops.
   */
  const bindMessages = (link: PeerLink): void => {
    link.onMessage((m) => {
      // Accumulate for pull-based consumers (MCP live_poll) — every inbound
      // message, current or queued, tagged with its sender.
      drainBuffer.push({
        from: link.hello.handle,
        id: m.id,
        text: m.text,
        at: m.at,
        queued: link !== current,
      });
      if (link === current) {
        deliver(link.hello.handle, m);
      } else {
        const buf = buffers.get(link) ?? [];
        buf.push(m);
        if (buf.length > MAX_BUFFERED) buf.shift();
        buffers.set(link, buf);
        notifyQueued(link.hello.handle, buf.length);
      }
    });
  };

  return {
    get available(): number {
      return queue.length;
    },
    current(): PeerLink | undefined {
      return current;
    },
    add(link: PeerLink): void {
      // Dedupe by identity: if a link from this identity (pubkey, or handle if legacy) already exists, close it.
      const isSamePeer = (a: PeerLink, b: PeerLink) => {
        if (a.hello.pubkey !== undefined && b.hello.pubkey !== undefined) {
          return a.hello.pubkey === b.hello.pubkey;
        }
        return a.hello.handle === b.hello.handle;
      };

      const existingIdx = queue.findIndex((l) => isSamePeer(l, link));
      if (existingIdx >= 0) {
        const old = queue.splice(existingIdx, 1)[0]!;
        old.close();
      } else if (current !== undefined && isSamePeer(current, link)) {
        const old = current;
        current = undefined;
        old.close();
      }

      watch(link);
      bindMessages(link); // bind ONCE, here — never in onMatch
      if (current === undefined) {
        setCurrent(link); // omegle auto-pair (fresh link → flush is a no-op)
      } else {
        queue.push(link);
        if (queue.length > MAX_QUEUE) {
          const oldest = queue.shift()!;
          oldest.close();
        }
      }
    },
    next(): PeerLink | undefined {
      if (current !== undefined) {
        current.close(); // local close — onClose won't fire, so advance manually
        current = undefined;
      }
      let nextUp: PeerLink | undefined;
      while (queue.length > 0) {
        const cand = queue.shift()!;
        if (!cand.closed) {
          nextUp = cand;
          break;
        }
      }
      setCurrent(nextUp);
      return current;
    },
    open(handle: string): PeerLink | undefined {
      const idx = queue.findIndex((l) => l.hello.handle === handle);
      if (idx < 0) return undefined; // no such waiting peer — leave current alone
      const link = queue.splice(idx, 1)[0]!; // idx >= 0 ⇒ exactly one removed
      if (current !== undefined) {
        current.close();
        current = undefined;
      }
      setCurrent(link);
      return current;
    },
    onMatch(cb: (link: PeerLink | undefined) => void): void {
      matchCbs.add(cb);
    },
    onMessage(cb: (from: string, m: IncomingMessage) => void): void {
      msgCbs.add(cb);
    },
    onQueued(cb: (from: string, queued: number) => void): void {
      queuedCbs.add(cb);
    },
    drain(): PairingMessage[] {
      return drainBuffer.splice(0);
    },
    queued(): PeerLink[] {
      return [...queue];
    },
  };
}
