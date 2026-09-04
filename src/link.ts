/**
 * PeerLink — one live peer connection, framed.
 *
 * MECHANISM lives in `@pooriaarab/vibe-core/link` (generic Duplex + injected
 * frame codec). This module is the vibedating POLICY wrapper: it wires the
 * concrete frame codec from `./frame.js`, maps the chat / signal / media
 * surface (`send` / `onMessage` / `sendSignal` / `onSignal`) onto the generic
 * `sendFrame` / `onFrame` API, and keeps the historical `createPeerLink(socket,
 * hello, initialBuffer, opts)` call signature so discovery + tests stay put.
 *
 * Hyperswarm discovery stays in `./p2p.js` and injects its socket here.
 */
import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import {
  createPeerLink as coreCreatePeerLink,
  type PeerLink as CorePeerLink,
} from '@pooriaarab/vibe-core/link';
import type { ReceivedMedia } from '@pooriaarab/vibe-core/media';
import {
  parseFrame,
  serializeFrame,
  type Frame,
  type MediaFrame,
  type RtcFrame,
} from './frame.js';
import type { PeerHello } from './p2p.js';

export type { ReceivedMedia };

/** Options for {@link createPeerLink}. */
export interface CreatePeerLinkOptions {
  /** Directory to write reassembled media files into (defaults to os.tmpdir()). */
  readonly mediaTmpDir?: string;
}

export interface PeerLink {
  /** The validated identity of the remote peer (from the hello handshake). */
  readonly hello: PeerHello;
  /** Whether the link has been closed. */
  readonly closed: boolean;
  /** Send a line of text as a `msg` frame. */
  send(text: string): void;
  /** Read a file from disk and send it as a chunked media transfer. */
  sendMedia(
    filePath: string,
    opts?: { mime?: string; name?: string },
  ): Promise<{ id: string; size: number }>;
  /** Relay one `rtc-*` signaling frame (offer / answer / ice) to the peer.
   *  Live media never touches this socket — only SDP / ICE strings do. */
  sendSignal(frame: RtcFrame): void;
  /** Register a callback for each incoming `msg` frame. */
  onMessage(cb: (m: { id: string; text: string; at: number }) => void): void;
  /** Register a callback fired for each fully-reassembled incoming media file. */
  onMedia(cb: (m: ReceivedMedia) => void): void;
  /** Register a callback fired for each incoming `rtc-*` signaling frame. */
  onSignal(cb: (f: RtcFrame) => void): void;
  /** Register a callback fired once when the peer closes the link. */
  onClose(cb: () => void): void;
  /** Omegle "next": write a `bye` frame, then end the socket. */
  close(): void;
}

/**
 * Build a vibedating {@link PeerLink} over `socket`. `initialBuffer` carries any
 * bytes the caller already buffered after the hello line (so frames sent right
 * after the hello are not dropped). Pure-ish: attaches listeners to `socket`.
 *
 * `initialBuffer` may be a utf8 string (legacy handshake leftover of JSON
 * control frames) or a raw Buffer (preferred once binary chunks can appear).
 */
export function createPeerLink(
  socket: Duplex,
  hello: PeerHello,
  initialBuffer: string | Buffer = '',
  linkOpts: CreatePeerLinkOptions = {},
): PeerLink {
  // Codec: vibedating's concrete Frame parser + serializer. Binary media-chunks
  // bypass the JSON path inside vibe-core's pullFramesFromBuffer.
  const codec = {
    parse: parseFrame,
    serialize: (frame: Frame) => serializeFrame(frame),
  };

  const core: CorePeerLink<Frame, PeerHello> = coreCreatePeerLink(socket, {
    codec,
    hello,
    initialBuffer,
    mediaTmpDir: linkOpts.mediaTmpDir,
    isBye: (f) => f.t === 'bye',
    isMedia: (f) =>
      f.t === 'media-start' || f.t === 'media-chunk' || f.t === 'media-end',
    byeFrame: { t: 'bye' },
  });

  return buildPeerLink(core, hello);
}

/**
 * Build the PeerLink object returned by {@link createPeerLink}.
 * Module-private; extracted to keep createPeerLink under the line budget.
 */
function buildPeerLink(
  core: CorePeerLink<Frame, PeerHello>,
  hello: PeerHello,
): PeerLink {
  const messageCbs = new Set<(m: { id: string; text: string; at: number }) => void>();
  const signalCbs = new Set<(f: RtcFrame) => void>();
  let subscribed = false;
  const ensureFrameDispatch = (): void => {
    if (subscribed) return;
    subscribed = true;
    core.onFrame((frame) => {
      if (frame.t === 'msg') {
        const m = { id: frame.id, text: frame.text, at: frame.at };
        for (const cb of messageCbs) cb(m);
        return;
      }
      if (frame.t === 'rtc-offer' || frame.t === 'rtc-answer' || frame.t === 'rtc-ice') {
        const f = frame as RtcFrame;
        for (const cb of signalCbs) cb(f);
      }
      // media-* is consumed by core's MediaReceiver when onMedia is registered;
      // bye / typing / hello have no message/signal fans here.
      void (frame as MediaFrame | Frame);
    });
  };

  return makeLinkHandlers(core, hello, {
    messageCbs,
    signalCbs,
    ensureFrameDispatch,
  });
}

/** Handler sets bundled to keep makeLinkHandlers under the param budget. */
interface LinkHandlers {
  messageCbs: Set<(m: { id: string; text: string; at: number }) => void>;
  signalCbs: Set<(f: RtcFrame) => void>;
  ensureFrameDispatch: () => void;
}

/**
 * Build the PeerLink method object. Extracted so its size doesn't count
 * toward the line budget of buildPeerLink.
 */
function makeLinkHandlers(
  core: CorePeerLink<Frame, PeerHello>,
  hello: PeerHello,
  h: LinkHandlers,
): PeerLink {
  return {
    get hello() {
      // core.hello is Hello | undefined; we always pass one.
      return core.hello ?? hello;
    },
    get closed() {
      return core.closed;
    },
    send(text) {
      if (core.closed) return;
      const frame: Frame = { t: 'msg', id: randomUUID(), text, at: Date.now() };
      core.sendFrame(frame);
    },
    async sendMedia(filePath, opts = {}) {
      return core.sendMedia(filePath, opts);
    },
    sendSignal(frame) {
      if (core.closed) return;
      core.sendFrame(frame);
    },
    onMessage(cb) {
      h.ensureFrameDispatch();
      h.messageCbs.add(cb);
    },
    onMedia(cb) {
      core.onMedia(cb);
    },
    onSignal(cb) {
      h.ensureFrameDispatch();
      h.signalCbs.add(cb);
    },
    onClose(cb) {
      core.onClose(cb);
    },
    close() {
      core.close();
    },
  };
}
