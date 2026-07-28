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
 * Message buffering (agent-native / MCP): every link is watched for `msg`
 * frames. Messages from the current match surface via {@link LivePairing.onMessage};
 * messages from queued (non-current) peers surface via {@link LivePairing.onQueued}.
 * Both also land in an internal drain buffer that {@link LivePairing.drain}
 * returns and empties — so a coding agent can poll instead of sitting on a TTY.
 *
 * This module knows nothing about hyperswarm, the DHT, or the wire — it only
 * shuffles {@link PeerLink}s handed to it. That keeps it trivially unit-testable
 * with fakes and keeps the policy out of the transport.
 *
 * Remote hang-ups are handled too: when the matched peer "next"s us, the link's
 * onClose fires and we auto-pair the next waiting link (omegle stays live).
 */
import type { PeerLink } from './link.js';

/** One inbound chat line, tagged with the sender and whether they were queued. */
export interface PairingMessage {
  /** Sender handle (from the validated hello — UNTRUSTED display data). */
  readonly from: string;
  readonly id: string;
  readonly text: string;
  readonly at: number;
  /** `true` when the sender was NOT the current match at receive time. */
  readonly queued: boolean;
}

export interface LivePairing {
  /** Number of unmatched links waiting in the queue. */
  readonly available: number;
  /** The currently-matched link, or `undefined` when idle. */
  current(): PeerLink | undefined;
  /** Snapshot of queued (non-current) links, in arrival order. */
  queued(): readonly PeerLink[];
  /**
   * Omegle "next": close the current match and advance to the next waiting link
   * (auto-pair), or go idle if the queue is empty. Returns the new current link
   * (which may be `undefined`).
   */
  next(): PeerLink | undefined;
  /**
   * Dating pick: match the available link whose `hello.handle === handle`.
   * Closes the current match first. Returns the matched link, or `undefined` if
   * no available link has that handle (the current match is left untouched).
   * When a match is selected, any of that peer's messages still sitting in the
   * drain buffer are left for the next {@link drain} call (they are already
   * tagged with `from`).
   */
  open(handle: string): PeerLink | undefined;
  /** Add a newly-arrived link (fed from discovery's `onLink`). Auto-pairs if idle. */
  add(link: PeerLink): void;
  /** Register a callback fired whenever the current match changes (incl. → idle). */
  onMatch(cb: (link: PeerLink | undefined) => void): void;
  /**
   * Register a callback fired for each inbound message from the CURRENT match.
   * Messages are also buffered for {@link drain}.
   */
  onMessage(cb: (m: PairingMessage) => void): void;
  /**
   * Register a callback fired for each inbound message from a QUEUED (non-current)
   * peer. Messages are also buffered for {@link drain}.
   */
  onQueued(cb: (m: PairingMessage) => void): void;
  /**
   * Drain and return every NEW inbound message since the last drain (current +
   * queued). Order is receive order. Empties the buffer.
   */
  drain(): PairingMessage[];
}

/** Construct an empty pairing policy. */
export function createPairing(): LivePairing {
  const queue: PeerLink[] = [];
  const matchCbs = new Set<(link: PeerLink | undefined) => void>();
  const messageCbs = new Set<(m: PairingMessage) => void>();
  const queuedCbs = new Set<(m: PairingMessage) => void>();
  const buffer: PairingMessage[] = [];
  let current: PeerLink | undefined;

  const emit = (link: PeerLink | undefined): void => {
    for (const cb of matchCbs) cb(link);
  };

  const pushMessage = (link: PeerLink, m: { id: string; text: string; at: number }): void => {
    const isQueued = current !== link;
    const msg: PairingMessage = {
      from: link.hello.handle,
      id: m.id,
      text: m.text,
      at: m.at,
      queued: isQueued,
    };
    buffer.push(msg);
    if (isQueued) {
      for (const cb of queuedCbs) cb(msg);
    } else {
      for (const cb of messageCbs) cb(msg);
    }
  };

  /**
   * Watch a link for a REMOTE hang-up. PeerLink only fires onClose on a remote
   * bye/end/error — a LOCAL close() (our own `next()`) never triggers this, so
   * there is no double-advance hazard.
   *
   * Also attach `onMessage` so every inbound chat line is buffered for the
   * agent-native poll path (and any onMessage/onQueued listeners).
   */
  const watch = (link: PeerLink): void => {
    link.onMessage((m) => pushMessage(link, m));
    link.onClose(() => {
      if (current === link) {
        current = undefined;
        const nextUp = queue.shift();
        if (nextUp !== undefined) {
          current = nextUp;
          emit(current);
        } else {
          emit(undefined);
        }
      } else {
        const idx = queue.indexOf(link);
        if (idx >= 0) queue.splice(idx, 1);
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
    queued(): readonly PeerLink[] {
      return queue.slice();
    },
    add(link: PeerLink): void {
      watch(link);
      if (current === undefined) {
        current = link; // omegle auto-pair
        emit(link);
      } else {
        queue.push(link);
      }
    },
    next(): PeerLink | undefined {
      if (current !== undefined) {
        current.close();
        current = undefined;
      }
      const nextUp = queue.shift();
      if (nextUp !== undefined) {
        current = nextUp;
      }
      emit(current);
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
      current = link;
      emit(current);
      return current;
    },
    onMatch(cb: (link: PeerLink | undefined) => void): void {
      matchCbs.add(cb);
    },
    onMessage(cb: (m: PairingMessage) => void): void {
      messageCbs.add(cb);
    },
    onQueued(cb: (m: PairingMessage) => void): void {
      queuedCbs.add(cb);
    },
    drain(): PairingMessage[] {
      const out = buffer.slice();
      buffer.length = 0;
      return out;
    },
  };
}
