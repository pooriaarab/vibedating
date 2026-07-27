/**
 * PeerLink — one live peer connection, framed.
 *
 * Wraps the hyperswarm `socket` (a Duplex) behind a tiny chat surface:
 *   - {@link PeerLink.send} writes a `msg` frame,
 *   - {@link PeerLink.onMessage} receives every `msg` frame the peer sends,
 *   - {@link PeerLink.onClose} fires when the peer hangs up (a `bye` frame,
 *     or the socket ending),
 *   - {@link PeerLink.close} is the omegle "next": writes `bye`, then ends.
 *
 * Everything on the wire goes through {@link parseFrame}'s allowlist, so a peer
 * can never smuggle extra fields onto a `msg` (and thus never a raw-usage field).
 *
 * The hello handshake has already happened by the time a link exists —
 * `hello` is the validated peer identity, captured at construction. The
 * connection handler may hand any leftover bytes (after the hello line) in
 * `initialBuffer` so frames sent immediately after hello are not lost.
 */
import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { parseFrame, serializeFrame, type Frame } from './frame.js';

export interface PeerLink {
  /** The validated identity of the remote peer (from the hello handshake). */
  readonly hello: { handle: string; league: string; harness: string };
  /** Send a line of text as a `msg` frame. */
  send(text: string): void;
  /** Register a callback for each incoming `msg` frame. */
  onMessage(cb: (m: { id: string; text: string; at: number }) => void): void;
  /** Register a callback fired once when the peer closes the link. */
  onClose(cb: () => void): void;
  /** Omegle "next": write a `bye` frame, then end the socket. */
  close(): void;
}

/**
 * Build a {@link PeerLink} over `socket`. `initialBuffer` carries any bytes the
 * caller already buffered after the hello line (so frames sent right after the
 * hello are not dropped). Pure-ish: attaches listeners to `socket`.
 */
export function createPeerLink(
  socket: Duplex,
  hello: { handle: string; league: string; harness: string },
  initialBuffer = '',
): PeerLink {
  const messageCbs = new Set<(m: { id: string; text: string; at: number }) => void>();
  const closeCbs = new Set<() => void>();
  let buf = initialBuffer;
  let closed = false;

  const dispatch = (frame: Frame): void => {
    switch (frame.t) {
      case 'msg': {
        const m = { id: frame.id, text: frame.text, at: frame.at };
        for (const cb of messageCbs) cb(m);
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
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim() === '') continue;
      const frame = parseFrame(line);
      if (frame === null) continue; // malformed/unknown frame — drop, never crash
      dispatch(frame);
    }
  };

  // Replay any leftover bytes the connection handler already had buffered.
  pump();

  socket.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
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
    send(text) {
      if (closed) return;
      const frame: Frame = { t: 'msg', id: randomUUID(), text, at: Date.now() };
      socket.write(serializeFrame(frame) + '\n');
    },
    onMessage(cb) {
      messageCbs.add(cb);
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
