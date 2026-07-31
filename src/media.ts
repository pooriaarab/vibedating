/**
 * Chunked file/image transfer over the live frame channel.
 *
 * MECHANISM (sendMedia / MediaReceiver / backpressure write) lives in
 * `@pooriaarab/vibe-core/media`. This module is a thin vibedating-facing
 * re-export that accepts a hyperswarm `socket` (Duplex) under the historical
 * `socket` option name and maps it onto vibe-core's injected `sink`.
 *
 * Wire layout is unchanged: `media-start` / binary `media-chunk` / `media-end`
 * (and the legacy JSON/base64 chunk path for bench/interop).
 */
import type { Duplex } from 'node:stream';
import {
  DEFAULT_CHUNK_BYTES,
  MediaReceiver,
  sendMedia as coreSendMedia,
  sendMediaFile as coreSendMediaFile,
  type MediaFrame as CoreMediaFrame,
  type MediaReceiverOptions,
  type ReceivedMedia,
  type SendResult,
} from '@pooriaarab/vibe-core/media';

export { DEFAULT_CHUNK_BYTES, MediaReceiver };
export type { MediaReceiverOptions, ReceivedMedia, SendResult };

/** Re-export the media frame union vibe-core accepts (start / chunk / end). */
export type MediaFrame = CoreMediaFrame;

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
  return coreSendMedia({
    sink: opts.socket,
    data: opts.data,
    mime: opts.mime,
    name: opts.name,
    id: opts.id,
    chunkBytes: opts.chunkBytes,
    legacyJson: opts.legacyJson,
  });
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
  return coreSendMediaFile({
    sink: opts.socket,
    path: opts.path,
    mime: opts.mime,
    name: opts.name,
    id: opts.id,
    chunkBytes: opts.chunkBytes,
    legacyJson: opts.legacyJson,
  });
}
