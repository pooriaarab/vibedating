/**
 * Named rooms — multi-peer GROUP discovery on the hyperswarm DHT.
 *
 * A room is its own DHT topic, `sha256('vibedate-room:' + name)`, entirely
 * separate from the league topics used by 1:1 matching (`vibedate:<league>`).
 * Every member joins the SAME topic and discovers ALL other members (not one
 * pairing): a live roster.
 *
 * Group TEXT chat is a fan-out broadcast — {@link RoomSession.broadcast} sends
 * one `msg` frame over each member's {@link PeerLink}, and every incoming `msg`
 * is surfaced (with the sender's handle) via {@link RoomSession.onMessage}.
 *
 * Group VIDEO is full-mesh WebRTC handled in the browser: each member connects
 * to each other member, reusing the existing `rtc-offer`/`answer`/`ice`
 * signaling per peer (targeted by handle, surfaced via
 * {@link RoomSession.onSignal} / {@link RoomSession.sendSignal}). The mesh is
 * fine to ~6 people; an SFU is the upgrade path for bigger rooms — noted here,
 * not built. `// ponytail:` a selective-forwarding unit is the scaling story.
 *
 * Reuse: this is a thin layer over {@link startDiscovery} (one room topic,
 * `acceptLeague: () => true` so rooms are intentionally cross-league) and
 * {@link PeerLink}. The wire protocol, the handshake allowlist, and the frame
 * allowlist are all inherited unchanged — a room member is just a discovered,
 * handshaken peer we happen to keep around instead of pairing one at a time.
 *
 * Privacy + AEGIS unchanged: rooms are consent-gated exactly like `live` (the
 * caller gates {@link startRoom} behind the `share:live` grant — see state.ts),
 * and peer text stays UNTRUSTED display data (the caller sanitizes before
 * printing). 1:1 modes are untouched — this module adds a new surface, it does
 * not alter the league/pairing path.
 */
import { createHash } from 'node:crypto';
import {
  startDiscovery,
  type DiscoverySession,
  type NotifySink,
  type PeerHello,
} from './p2p.js';
import type { PeerLink } from './link.js';
import type { RtcFrame } from './frame.js';

/** Namespace prefix so room topics never collide with league topics (or anything
 *  else on the DHT). Mirrors {@link p2p.TOPIC_PREFIX} for the 1:1 path. */
export const ROOM_TOPIC_PREFIX = 'vibedate-room:';

/**
 * Derive the 32-byte DHT topic for a named room. Deterministic: everyone who
 * joins the same room name anywhere in the world hashes to the same topic,
 * which is the entire discovery mechanism. Pure (mirrors {@link p2p.leagueTopic}).
 */
export function roomTopic(name: string): Buffer {
  return createHash('sha256').update(`${ROOM_TOPIC_PREFIX}${name}`, 'utf8').digest();
}

/** A room member = a connected, handshaken peer. Same shape as a live peer. */
export type RoomMember = PeerHello;

/** One group chat message: a `msg` frame's payload tagged with the sender. */
export interface RoomMessage {
  /** Sender's handle (from the validated hello — UNTRUSTED display data). */
  readonly from: string;
  readonly id: string;
  readonly text: string;
  readonly at: number;
}

export interface RoomOptions {
  /** What we broadcast. Must already be consent-gated by the caller. */
  readonly hello: PeerHello;
  /** Room name → its own DHT topic (see {@link roomTopic}). */
  readonly room: string;
  /** DHT bootstrap nodes; omit for the public DHT. Tests pass a local testnet. */
  readonly bootstrap?: ReadonlyArray<{ readonly host: string; readonly port: number }>;
  /** Where peers.json lives. Defaults to ~/.vibedating. */
  readonly stateDir?: string;
  /** Predicate over a blocked handle — a blocked peer's hello is dropped exactly
   *  like in 1:1 discovery. Default: nothing blocked. */
  readonly isBlocked?: (handle: string) => boolean;
  /** Match-notification sink (tests capture with a fake). Best-effort. */
  readonly notify?: NotifySink;
}

export interface RoomSession {
  /** The room name. */
  readonly room: string;
  /** The joined DHT topic (see {@link roomTopic}). */
  readonly topic: Buffer;
  /** What we broadcast. */
  readonly hello: PeerHello;
  /** Live member set, keyed by handle (excludes self). Mirrors the live view
   *  semantics of {@link p2p.DiscoverySession.peers}. */
  readonly members: ReadonlyMap<string, RoomMember>;
  /** Resolves when the first DHT announce/lookup round completes. */
  readonly ready: Promise<unknown>;
  /**
   * Broadcast a text message to ALL room members (fan-out: one `msg` frame per
   * member's {@link PeerLink}). Returns the handles the message was sent to.
   * Best-effort: a member whose link has just closed is skipped silently.
   */
  broadcast(text: string): readonly string[];
  /** Register a callback fired for each incoming group message (with sender). */
  onMessage(cb: (m: RoomMessage) => void): void;
  /** Register a callback fired whenever the member roster changes (join/leave). */
  onRoster(cb: (members: readonly RoomMember[]) => void): void;
  /** Register a callback fired for each incoming `rtc-*` signaling frame,
   *  tagged with the sender's handle (full-mesh video signaling). */
  onSignal(cb: (from: string, frame: RtcFrame) => void): void;
  /** Relay one `rtc-*` signaling frame to one member (by handle). */
  sendSignal(handle: string, frame: RtcFrame): void;
  /** The underlying {@link PeerLink} to a member (by handle), or undefined. */
  linkFor(handle: string): PeerLink | undefined;
  /** Leave the room and destroy the node. Idempotent. */
  close(): Promise<void>;
}

/** Internal: a member's hello + its live link. */
interface MemberEntry {
  readonly hello: RoomMember;
  readonly link: PeerLink;
}

/**
 * Join (or create) a named room on the DHT and discover ALL members. CONSENT
 * GATE LIVES WITH THE CALLER — never call this without the `share:live` grant
 * (or an explicit opt-in in the same breath), exactly like
 * {@link p2p.startDiscovery}.
 *
 * Resolves once the first DHT announce/lookup round completes; the returned
 * session's {@link RoomSession.members} map + {@link RoomSession.onRoster}
 * callback track every member that joins or leaves thereafter.
 */
export async function startRoom(opts: RoomOptions): Promise<RoomSession> {
  const topic = roomTopic(opts.room);

  // Internal entries (hello + link) and the live, public hello-only view.
  const entries = new Map<string, MemberEntry>();
  const memberHellos = new Map<string, RoomMember>();

  const messageCbs = new Set<(m: RoomMessage) => void>();
  const rosterCbs = new Set<(members: readonly RoomMember[]) => void>();
  const signalCbs = new Set<(from: string, frame: RtcFrame) => void>();

  const fireRoster = (): void => {
    const snapshot = [...memberHellos.values()];
    for (const cb of rosterCbs) cb(snapshot);
  };

  let discovery: DiscoverySession | undefined;
  const ready = startDiscovery({
    hello: opts.hello,
    // ONE topic — the room's own. Rooms are intentionally cross-league, so
    // every member of the room is accepted regardless of advertised league.
    topics: [topic],
    acceptLeague: () => true,
    ...(opts.isBlocked === undefined ? {} : { isBlocked: opts.isBlocked }),
    ...(opts.bootstrap === undefined ? {} : { bootstrap: opts.bootstrap }),
    ...(opts.stateDir === undefined ? {} : { stateDir: opts.stateDir }),
    ...(opts.notify === undefined ? {} : { notify: opts.notify }),
    onLink: (link) => {
      const handle = link.hello.handle;
      // A reconnect may supersede a stale entry for the same handle — replace
      // and re-fire the roster either way (join or rejoin look the same to
      // observers).
      entries.set(handle, { hello: link.hello, link });
      memberHellos.set(handle, link.hello);
      fireRoster();
      // Route every group message from this member to the room's onMessage set.
      // (messageCbs is a LIVE set, so a callback registered after the link
      // exists still receives every future message — same discipline as the
      // 1:1 PeerLink.)
      link.onMessage((m) => {
        for (const cb of messageCbs) cb({ from: handle, ...m });
      });
      // Same for rtc-* signaling frames (full-mesh video).
      link.onSignal((frame) => {
        for (const cb of signalCbs) cb(handle, frame);
      });
      link.onClose(() => {
        const cur = entries.get(handle);
        // Only drop if THIS link is still the current one for the handle (a
        // reconnect may have already replaced it).
        if (cur && cur.link === link) {
          entries.delete(handle);
          memberHellos.delete(handle);
          fireRoster();
        }
      });
    },
  }).then((s) => {
    discovery = s;
    return s.ready;
  });

  const session: RoomSession = {
    room: opts.room,
    topic,
    hello: opts.hello,
    members: memberHellos,
    ready,
    broadcast(text) {
      const reached: string[] = [];
      for (const [handle, entry] of entries) {
        entry.link.send(text);
        reached.push(handle);
      }
      return reached;
    },
    onMessage(cb) {
      messageCbs.add(cb);
    },
    onRoster(cb) {
      rosterCbs.add(cb);
    },
    onSignal(cb) {
      signalCbs.add(cb);
    },
    sendSignal(handle, frame) {
      entries.get(handle)?.link.sendSignal(frame);
    },
    linkFor(handle) {
      return entries.get(handle)?.link;
    },
    async close() {
      // Ensure discovery is assigned (ready resolves only after the assignment)
      // before closing; swallow a rejection (offline / DHT unreachable).
      await ready.catch(() => undefined);
      // Best-effort close of every member link so peers see a bye frame.
      for (const entry of entries.values()) {
        try {
          entry.link.close();
        } catch {
          /* already gone */
        }
      }
      entries.clear();
      memberHellos.clear();
      if (discovery !== undefined) await discovery.close();
    },
  };
  return session;
}
