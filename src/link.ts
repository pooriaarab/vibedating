/**
 * PeerLink — one live peer connection, framed.
 *
 * Wraps the hyperswarm `socket` (a Duplex) behind a tiny chat surface:
 *   - {@link PeerLink.send} writes a `msg` frame,
 *   - {@link PeerLink.onMessage} receives every `msg` frame the peer sends,
 *   - {@link PeerLink.onClose} fires when the peer hangs up (a `bye` frame,
 *     or the socket ending),
 *   - {@link PeerLink.close} is the omegle "next": writes `bye`, then ends.
 *   - {@link PeerLink.sendMedia} / {@link PeerLink.onMedia} move chunked files,
 *   - {@link PeerLink.sendSignal} / {@link PeerLink.onSignal} relay the three
 *     `rtc-*` WebRTC signaling frames (offer / answer / ice). Live A/V itself
 *     runs in the browser; these only ferry signaling over the P2P socket.
 *
 * Wire mux (same socket for text + media + signal):
 *   - Control / text frames are newline-JSON (start with `{`).
 *   - Media CHUNK payloads are length-prefixed binary frames tagged 0x01.
 *   {@link pullFramesFromBuffer} demuxes both without ambiguity.
 *
 * Everything on the wire goes through {@link parseFrame}'s allowlist (JSON) or
 * the binary chunk header allowlist (id+seq only), so a peer can never smuggle
 * extra fields onto a `msg` (and thus never a raw-usage field). The same
 * allowlist guards every `media-*` control frame, so the file-transfer path
 * inherits the exact same invariant.
 *
 * The hello handshake has already happened by the time a link exists —
 * `hello` is the validated peer identity, captured at construction. The
 * connection handler may hand any leftover bytes (after the hello line) in
 * `initialBuffer` so frames sent immediately after hello are not lost.
 */
import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import {
  parseFrame,
  pullFramesFromBuffer,
  serializeFrame,
  type Frame,
  type MediaFrame,
  type RtcFrame,
} from './frame.js';
import {
  MediaReceiver,
  type ReceivedMedia,
  sendMediaFile,
} from './media.js';
import type { PeerHello } from './p2p.js';

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
 * Build a {@link PeerLink} over `socket`. `initialBuffer` carries any bytes the
 * caller already buffered after the hello line (so frames sent right after the
 * hello are not dropped). Pure-ish: attaches listeners to `socket`.
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
  const messageCbs = new Set<(m: { id: string; text: string; at: number }) => void>();
  const mediaCbs = new Set<(m: ReceivedMedia) => void>();
  const signalCbs = new Set<(f: RtcFrame) => void>();
  const closeCbs = new Set<() => void>();
  // Byte-oriented buffer so binary media-chunks and newline-JSON coexist.
  let buf: Buffer =
    typeof initialBuffer === 'string'
      ? Buffer.from(initialBuffer, 'utf8')
      : Buffer.from(initialBuffer);
  let closed = false;

  // Lazily created on the first onMedia() registration so a link that nobody
  // listens for media on never touches the disk (media frames are then just
  // dropped, like 'typing').
  let mediaReceiver: MediaReceiver | undefined;
  const ensureMediaReceiver = (): MediaReceiver => {
    if (!mediaReceiver) {
      mediaReceiver = new MediaReceiver(
        (m) => {
          for (const cb of mediaCbs) cb(m);
        },
        { tmpDir: linkOpts.mediaTmpDir },
      );
    }
    return mediaReceiver;
  };

  const dispatch = (frame: Frame): void => {
    switch (frame.t) {
      case 'msg': {
        const m = { id: frame.id, text: frame.text, at: frame.at };
        for (const cb of messageCbs) cb(m);
        break;
      }
      case 'media-start':
      case 'media-chunk':
      case 'media-end': {
        mediaReceiver?.handle(frame as MediaFrame);
        break;
      }
      case 'rtc-offer':
      case 'rtc-answer':
      case 'rtc-ice': {
        const f = frame as RtcFrame;
        for (const cb of signalCbs) cb(f);
        break;
      }
      case 'bye': {
        if (!closed) {
          closed = true;
          for (const cb of closeCbs) cb();
        }
        break;
      }
      // 'hello' / 'typing' have no meaning at the link layer — hello already
      // happened; typing is a future affordance. Ignore silently.
      default:
        break;
    }
  };

  const pump = (): void => {
    if (buf.length === 0) return;
    const { frames, rest } = pullFramesFromBuffer(buf);
    buf = rest;
    for (const frame of frames) dispatch(frame);
  };

  // Replay any leftover bytes the connection handler already had buffered.
  pump();

  socket.on('data', (chunk: Buffer | string) => {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    buf = buf.length === 0 ? Buffer.from(bytes) : Buffer.concat([buf, bytes]);
    pump();
  });
  socket.on('end', () => {
    if (!closed) {
      closed = true;
      for (const cb of closeCbs) cb();
    }
  });
  socket.on('close', () => {
    if (!closed) {
      closed = true;
      for (const cb of closeCbs) cb();
    }
  });
  socket.on('error', () => {
    // Peer vanished — surface as a close so callers stop waiting. Never throw.
    if (!closed) {
      closed = true;
      for (const cb of closeCbs) cb();
    }
  });

  return {
    hello,
    get closed() { return closed; },
    send(text) {
      if (closed) return;
      const frame: Frame = { t: 'msg', id: randomUUID(), text, at: Date.now() };
      socket.write(serializeFrame(frame) + '\n');
    },
    async sendMedia(filePath, opts = {}) {
      if (closed) return { id: '', size: 0 };
      return sendMediaFile({ socket, path: filePath, mime: opts.mime, name: opts.name });
    },
    sendSignal(frame) {
      if (closed) return;
      socket.write(serializeFrame(frame) + '\n');
    },
    onMessage(cb) {
      messageCbs.add(cb);
    },
    onMedia(cb) {
      ensureMediaReceiver();
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
      closed = true; // a locally-initiated close does NOT re-fire our own onClose
      try {
        socket.write(serializeFrame({ t: 'bye' }) + '\n');
      } catch {
        /* socket already gone — nothing more to do */
      }
      try {
        socket.end();
      } catch {
        /* already ended */
      }
    },
  };
}
