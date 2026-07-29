/**
 * Chunked file/image transfer over the live frame channel.
 *
 * Two halves of one transfer:
 *
 *  - {@link sendMedia} / {@link sendMediaFile} — the SENDER. Reads bytes,
 *    emits a `media-start` frame (newline-JSON), then one BINARY media-chunk
 *    frame per slice (raw bytes, no base64) HONORING BACKPRESSURE (if
 *    `socket.write` returns false it awaits the `'drain'` event before the next
 *    chunk), then a `media-end` frame.
 *
 *  - {@link MediaReceiver} — the RECEIVER. Reassembles the chunks IN SEQ
 *    ORDER, rejecting a transfer if the running total exceeds the declared
 *    size (or the 25 MiB hard cap) or a duplicate / out-of-order seq arrives.
 *    Accepts both binary-wire chunks (`data: Buffer`) and legacy JSON/base64
 *    chunks (`b64: string`). On `media-end`, if every declared byte arrived,
 *    writes the file to a temp path and fires {@link MediaReceiver.onMedia}
 *    `{mime, name, path, size}`.
 *
 * Every control frame goes through {@link parseFrame}'s allowlist — a peer can
 * never smuggle an extra (e.g. raw-usage) field onto a media frame. Binary
 * chunk headers are independently allowlisted (id + seq only).
 *
 * The PeerLink wires {@link PeerLink.onMedia} to a {@link MediaReceiver} and
 * {@link PeerLink.sendMedia} to {@link sendMediaFile}, so callers never touch
 * the raw socket.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import {
  MAX_BINARY_CHUNK_BYTES,
  MAX_MEDIA_SIZE,
  MAX_MIME_LEN,
  MAX_NAME_LEN,
  serializeBinaryMediaChunk,
  serializeFrame,
  type MediaFrame,
} from './frame.js';

/* -------------------------------------------------------------------------- */
/* Sender                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Raw bytes per binary media-chunk. 64 KiB is the binary payload cap
 * ({@link MAX_BINARY_CHUNK_BYTES}); the old 12 KiB default existed only because
 * base64 of 12 KiB raw filled the 16 KiB JSON b64 ceiling exactly.
 */
export const DEFAULT_CHUNK_BYTES = MAX_BINARY_CHUNK_BYTES;

/** Minimal extension → MIME map for sender-side inference. */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

function inferMime(name: string): string {
  return MIME_BY_EXT[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Write one buffer (or string) honoring backpressure. Resolves once the sink
 * has either accepted the write synchronously (returned true) or, when it
 * returns false, after the `'drain'` event fires — so a slow socket throttles
 * the sender instead of buffering unbounded chunks in memory.
 */
function writeBytes(socket: Duplex, data: string | Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const ok = socket.write(data);
    if (ok) resolve();
    else {
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(new Error('Socket closed before drain'));
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        socket.removeListener('drain', onDrain);
        socket.removeListener('close', onClose);
        socket.removeListener('error', onError);
      };
      socket.once('drain', onDrain);
      socket.once('close', onClose);
      socket.once('error', onError);
    }
  });
}

export interface SendMediaOptions {
  /** The peer socket (a hyperswarm Duplex). */
  readonly socket: Duplex;
  /** Full file contents to send. */
  readonly data: Buffer;
  /** MIME type, announced on `media-start`. */
  readonly mime: string;
  /** File name, announced on `media-start`. */
  readonly name: string;
  /** Transfer id; generated if omitted. */
  readonly id?: string;
  /** Raw bytes per chunk (defaults to {@link DEFAULT_CHUNK_BYTES}). */
  readonly chunkBytes?: number;
  /**
   * Force the legacy newline-JSON/base64 chunk path. Used by the bench OLD-vs-NEW
   * comparison; production always uses the binary path.
   */
  readonly legacyJson?: boolean;
}

export interface SendResult {
  readonly id: string;
  readonly size: number;
}

/**
 * Send an in-memory buffer as a chunked media transfer. Throws if the data
 * exceeds the 25 MiB cap or the mime/name overshoot the protocol limits
 * (the receiver would drop such a transfer anyway).
 *
 * By default chunks are framed as binary media-chunks (raw bytes). Pass
 * `legacyJson: true` to emit the old base64 newline-JSON chunks instead
 * (bench comparison only).
 */
export async function sendMedia(opts: SendMediaOptions): Promise<SendResult> {
  const { socket, data, mime, name } = opts;
  const id = opts.id ?? randomUUID();
  const size = data.length;
  if (size > MAX_MEDIA_SIZE) {
    throw new Error(`media too large: ${size} bytes exceeds ${MAX_MEDIA_SIZE} byte cap`);
  }
  if (mime.length > MAX_MIME_LEN) throw new Error(`mime too long: ${mime.length} > ${MAX_MIME_LEN}`);
  if (name.length > MAX_NAME_LEN) throw new Error(`name too long: ${name.length} > ${MAX_NAME_LEN}`);

  await writeBytes(socket, serializeFrame({ t: 'media-start', id, mime, size, name }) + '\n');

  const chunkBytes = Math.min(
    opts.chunkBytes ?? DEFAULT_CHUNK_BYTES,
    opts.legacyJson
      ? Math.floor((16 * 1024 * 3) / 4) // legacy b64 cap → 12288 raw
      : MAX_BINARY_CHUNK_BYTES,
  );
  let seq = 0;
  for (let off = 0; off < size; off += chunkBytes) {
    const slice = data.subarray(off, off + chunkBytes);
    if (opts.legacyJson) {
      const b64 = slice.toString('base64');
      await writeBytes(socket, serializeFrame({ t: 'media-chunk', id, seq, b64 }) + '\n');
    } else {
      await writeBytes(socket, serializeBinaryMediaChunk({ id, seq, data: slice }));
    }
    seq++;
  }

  await writeBytes(socket, serializeFrame({ t: 'media-end', id }) + '\n');
  return { id, size };
}

export interface SendMediaFileOptions {
  readonly socket: Duplex;
  /** Path to the file to read + send. */
  readonly path: string;
  /** MIME type; inferred from the extension if omitted. */
  readonly mime?: string;
  /** File name; defaults to the basename of `path`. */
  readonly name?: string;
  readonly id?: string;
  readonly chunkBytes?: number;
  readonly legacyJson?: boolean;
}

/** Read a file from disk and send it via {@link sendMedia}. */
export async function sendMediaFile(opts: SendMediaFileOptions): Promise<SendResult> {
  const data = await readFile(opts.path);
  const name = opts.name ?? path.basename(opts.path);
  const mime = opts.mime ?? inferMime(name);
  return sendMedia({
    socket: opts.socket,
    data,
    mime,
    name,
    id: opts.id,
    chunkBytes: opts.chunkBytes,
    legacyJson: opts.legacyJson,
  });
}

/* -------------------------------------------------------------------------- */
/* Receiver                                                                   */
/* -------------------------------------------------------------------------- */

export interface ReceivedMedia {
  readonly mime: string;
  readonly name: string;
  /** Temp file path holding the reassembled bytes. */
  readonly path: string;
  readonly size: number;
  readonly error?: Error;
}

interface Transfer {
  readonly mime: string;
  readonly name: string;
  /** Declared total size (bytes) from `media-start`. */
  readonly size: number;
  /** Next expected chunk seq (chunks must arrive 0, 1, 2, … in order). */
  nextSeq: number;
  readonly chunks: Buffer[];
  /** Running total of decoded bytes received so far. */
  received: number;
}

/** Build a safe temp filename `<id><ext>`, keeping the original extension. */
function safeName(id: string, name: string): string {
  const ext = path.extname(name);
  return ext && /^\.[A-Za-z0-9]{1,16}$/.test(ext) ? `${id}${ext}` : id;
}

/**
 * Reassembles incoming media frames into a file.
 *
 * Invariants enforced:
 *  - chunks arrive in seq order (0, 1, 2, …); a duplicate or out-of-order seq
 *    aborts the transfer,
 *  - the running byte total may not exceed the declared `media-start.size`
 *    (nor the 25 MiB hard cap) — otherwise the transfer is aborted,
 *  - `media-end` only delivers when `received === size` (every declared byte
 *    arrived); an incomplete transfer is dropped silently.
 *
 * On success the bytes are written to a temp file and {@link onMedia} fires.
 */
export class MediaReceiver {
  private readonly transfers = new Map<string, Transfer>();

  constructor(
    private readonly onMedia: (m: ReceivedMedia) => void,
    private readonly opts: { tmpDir?: string } = {},
  ) {}

  /** Abort a transfer (drop all state for `id`) without delivering. */
  private abort(id: string): void {
    this.transfers.delete(id);
  }

  /** Feed one parsed media frame. Never throws. */
  handle(frame: MediaFrame): void {
    switch (frame.t) {
      case 'media-start': {
        // A re-start for an existing id resets state.
        this.transfers.set(frame.id, {
          mime: frame.mime,
          name: frame.name,
          size: frame.size,
          nextSeq: 0,
          chunks: [],
          received: 0,
        });
        return;
      }
      case 'media-chunk': {
        const tx = this.transfers.get(frame.id);
        if (!tx) return; // chunk without a start — drop
        // Enforce strict in-order delivery: any dup or out-of-order seq aborts.
        if (frame.seq !== tx.nextSeq) {
          this.abort(frame.id);
          return;
        }
        let bytes: Buffer;
        if ('data' in frame && Buffer.isBuffer(frame.data)) {
          // Binary wire path — payload already raw.
          bytes = frame.data;
          if (bytes.length === 0 || bytes.length > MAX_BINARY_CHUNK_BYTES) {
            this.abort(frame.id);
            return;
          }
        } else if ('b64' in frame && typeof frame.b64 === 'string') {
          // Legacy JSON/base64 path (still accepted for interoperability).
          try {
            bytes = Buffer.from(frame.b64, 'base64');
          } catch {
            this.abort(frame.id);
            return;
          }
        } else {
          this.abort(frame.id);
          return;
        }
        const received = tx.received + bytes.length;
        // Reject if the running total overshoots the declared size or the cap.
        if (received > tx.size || received > MAX_MEDIA_SIZE) {
          this.abort(frame.id);
          return;
        }
        tx.chunks.push(bytes);
        tx.received = received;
        tx.nextSeq += 1;
        return;
      }
      case 'media-end': {
        const tx = this.transfers.get(frame.id);
        if (!tx) return;
        this.transfers.delete(frame.id);
        // Only deliver when every declared byte arrived in order.
        if (tx.received !== tx.size) return;
        const buf = Buffer.concat(tx.chunks, tx.received);
        const filePath = path.join(this.opts.tmpDir ?? os.tmpdir(), safeName(frame.id, tx.name));
        try {
          writeFileSync(filePath, buf);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          this.onMedia({ mime: tx.mime, name: tx.name, path: filePath, size: tx.received, error });
          return;
        }
        this.onMedia({ mime: tx.mime, name: tx.name, path: filePath, size: tx.received });
        return;
      }
      default:
        return;
    }
  }
}
