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
 */
import type { PeerLink } from './link.js';

export interface LivePairing {
  /** Number of unmatched links waiting in the queue. */
  readonly available: number;
  /** The currently-matched link, or `undefined` when idle. */
  current(): PeerLink | undefined;
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
   */
  open(handle: string): PeerLink | undefined;
  /** Add a newly-arrived link (fed from discovery's `onLink`). Auto-pairs if idle. */
  add(link: PeerLink): void;
  /** Register a callback fired whenever the current match changes (incl. → idle). */
  onMatch(cb: (link: PeerLink | undefined) => void): void;
}

/** Construct an empty pairing policy. */
export function createPairing(): LivePairing {
  const queue: PeerLink[] = [];
  const matchCbs = new Set<(link: PeerLink | undefined) => void>();
  let current: PeerLink | undefined;

  const emit = (link: PeerLink | undefined): void => {
    for (const cb of matchCbs) cb(link);
  };

  /**
   * Watch a link for a REMOTE hang-up. PeerLink only fires onClose on a remote
   * bye/end/error — a LOCAL close() (our own `next()`) never triggers this, so
   * there is no double-advance hazard.
   */
  const watch = (link: PeerLink): void => {
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
  };
}
