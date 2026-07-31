/** Live-session wire frames.
 *
 *  Control / text frames (hello, msg, typing, bye, media-start, media-end,
 *  rtc-*) stay newline-JSON. Media CHUNK payloads travel as raw binary on the
 *  same socket (see {@link serializeBinaryMediaChunk}) so we avoid the ~33%
 *  base64 tax and the per-chunk JSON envelope.
 *
 *  Same allowlist discipline as p2p.parseHandshake: build results key-by-key,
 *  cap sizes, drop unknown frame types — a peer can never leak extra fields.
 *
 *  MECHANISM (defineFrames combinator + binary media-chunk mux) lives in
 *  `@pooriaarab/vibe-core/frame`. The concrete frame UNION (chat/media/rtc/hello
 *  shapes + size caps for sdp/candidate/text) is POLICY and stays LOCAL so the
 *  wire shape remains byte-identical for live peers.
 */
import {
  BIN_MEDIA_CHUNK_TAG,
  DEFAULT_MAX_FRAME_LEN,
  HELLO_PUBKEY_HEX_LEN,
  HELLO_SIG_HEX_LEN,
  MAX_B64_CHUNK_LEN,
  MAX_BINARY_CHUNK_BYTES,
  MAX_HELLO_NONCE_HEX_LEN,
  MAX_ID_LEN,
  MAX_MEDIA_SIZE,
  MAX_MIME_LEN,
  MAX_NAME_LEN,
  defineFrames,
  num,
  optBool,
  optStr,
  pullFramesFromBuffer as corePullFramesFromBuffer,
  serializeBinaryMediaChunk,
  str,
  tryParseBinaryMediaChunk,
  type BinaryMediaChunkParts,
} from '@pooriaarab/vibe-core/frame';

export {
  BIN_MEDIA_CHUNK_TAG,
  HELLO_PUBKEY_HEX_LEN,
  HELLO_SIG_HEX_LEN,
  MAX_B64_CHUNK_LEN,
  MAX_BINARY_CHUNK_BYTES,
  MAX_HELLO_NONCE_HEX_LEN,
  MAX_ID_LEN,
  MAX_MEDIA_SIZE,
  MAX_MIME_LEN,
  MAX_NAME_LEN,
  serializeBinaryMediaChunk,
  tryParseBinaryMediaChunk,
};
export type { BinaryMediaChunkParts };

export const MAX_TEXT_LEN = 4000;
/** Largest `sdp` string accepted on an `rtc-offer` / `rtc-answer` frame.
 *  Browser SDP blobs are typically 1-4 KiB; 64 KiB is a generous ceiling that
 *  still keeps a single signaling line cheap to buffer and parse. */
export const MAX_SDP_LEN = 64 * 1024; // 64 KiB
/** Largest `candidate` string accepted on an `rtc-ice` frame. ICE candidate
 *  lines are tiny (<1 KiB); 4 KiB is a generous ceiling. */
export const MAX_CANDIDATE_LEN = 4 * 1024; // 4 KiB

/**
 * Per-line cap sized to admit the LARGEST legal JSON frame AFTER escaping —
 * matches vibe-core's DEFAULT_MAX_FRAME_LEN (worst-case escaped SDP + wrapper).
 */
const MAX_FRAME_LEN = DEFAULT_MAX_FRAME_LEN;

const HEX_PUBKEY = new RegExp(`^[0-9a-fA-F]{${HELLO_PUBKEY_HEX_LEN}}$`);
const HEX_SIG = new RegExp(`^[0-9a-fA-F]{${HELLO_SIG_HEX_LEN}}$`);
const HEX_NONCE = new RegExp(`^[0-9a-fA-F]{1,${MAX_HELLO_NONCE_HEX_LEN}}$`);

/**
 * vibedating's concrete frame allowlist. Compiles to parse/serialize that
 * match the previous hand-rolled parser field-for-field (including the
 * soft-default of `harness: 'unknown'` when a legacy hello omits it).
 */
const codec = defineFrames(
  [
    { t: 'bye', fields: {} },
    { t: 'typing', fields: {} },
    {
      t: 'hello',
      fields: {
        handle: str('handle'),
        league: str('league'),
        // Optional on the wire so legacy peers that omit harness still parse;
        // default applied in parseFrame below (matches prior hand-rolled path).
        harness: optStr('harness'),
        verified: optBool('verified'),
        pubkey: optStr('pubkey', { pattern: HEX_PUBKEY }),
        nonce: optStr('nonce', { pattern: HEX_NONCE }),
        sig: optStr('sig', { pattern: HEX_SIG }),
      },
    },
    {
      t: 'msg',
      fields: {
        id: str('id', { minLen: 1, maxLen: MAX_ID_LEN }),
        text: str('text', { minLen: 1, maxLen: MAX_TEXT_LEN }),
        at: num('at'),
      },
    },
    {
      t: 'media-start',
      fields: {
        id: str('id', { minLen: 1, maxLen: MAX_ID_LEN }),
        mime: str('mime', { maxLen: MAX_MIME_LEN }),
        size: num('size', { integer: true, min: 0, max: MAX_MEDIA_SIZE }),
        name: str('name', { maxLen: MAX_NAME_LEN }),
      },
    },
    {
      t: 'media-chunk',
      fields: {
        id: str('id', { minLen: 1, maxLen: MAX_ID_LEN }),
        seq: num('seq', { integer: true, min: 0 }),
        b64: str('b64', { minLen: 1, maxLen: MAX_B64_CHUNK_LEN }),
      },
    },
    {
      t: 'media-end',
      fields: {
        id: str('id', { minLen: 1, maxLen: MAX_ID_LEN }),
      },
    },
    {
      t: 'rtc-offer',
      fields: {
        sdp: str('sdp', { minLen: 1, maxLen: MAX_SDP_LEN }),
      },
    },
    {
      t: 'rtc-answer',
      fields: {
        sdp: str('sdp', { minLen: 1, maxLen: MAX_SDP_LEN }),
      },
    },
    {
      t: 'rtc-ice',
      fields: {
        // Empty candidate is a legal trickle-ICE "end of gathering" marker.
        candidate: str('candidate', { maxLen: MAX_CANDIDATE_LEN }),
      },
    },
  ] as const,
  { maxFrameLen: MAX_FRAME_LEN },
);

/** Concrete vibedating frame union (JSON control path + binary media-chunk). */
export type Frame =
  | {
      t: 'hello';
      handle: string;
      league: string;
      harness: string;
      verified?: boolean;
      pubkey?: string;
      nonce?: string;
      sig?: string;
    }
  | { t: 'msg'; id: string; text: string; at: number }
  | { t: 'typing' }
  | { t: 'bye' }
  | { t: 'media-start'; id: string; mime: string; size: number; name: string }
  /** Legacy JSON media-chunk (base64). Prefer binary wire for new sends. */
  | { t: 'media-chunk'; id: string; seq: number; b64: string }
  /** Binary-path media-chunk: raw bytes, no base64. Produced by the binary framer. */
  | { t: 'media-chunk'; id: string; seq: number; data: Buffer }
  | { t: 'media-end'; id: string }
  | { t: 'rtc-offer'; sdp: string }
  | { t: 'rtc-answer'; sdp: string }
  | { t: 'rtc-ice'; candidate: string };

/** Convenience union of the three media-transfer frame types. */
export type MediaFrame = Extract<Frame, { t: `media-${string}` }>;

/** A media-chunk that already carries decoded bytes (binary wire path). */
export type BinaryMediaChunkFrame = Extract<Frame, { t: 'media-chunk'; data: Buffer }>;

/** Convenience union of the three WebRTC signaling frame types (offer / answer
 *  / ice). Live A/V runs in the BROWSER via a native RTCPeerConnection; these
 *  frames only RELAY signaling over the P2P socket — no media bytes, no native
 *  WebRTC dependency in the CLI. */
export type RtcFrame = Extract<Frame, { t: `rtc-${string}` }>;

export function serializeFrame(f: Frame): string {
  // Binary media-chunks have a dedicated encoder — never JSON-encode a Buffer.
  if (f.t === 'media-chunk' && 'data' in f) {
    throw new Error('binary media-chunk must use serializeBinaryMediaChunk, not serializeFrame');
  }
  return codec.serialize(f as Exclude<Frame, { t: 'media-chunk'; data: Buffer }>);
}

export function parseFrame(raw: string | Buffer): Frame | null {
  const parsed = codec.parse(raw);
  if (parsed === null) return null;
  // Soft-default harness for legacy hellos that omit it — same as the prior
  // hand-rolled parser (`typeof harness === 'string' ? harness : 'unknown'`).
  if (parsed.t === 'hello') {
    const hello = parsed as {
      readonly t: 'hello';
      readonly handle: string;
      readonly league: string;
      readonly harness?: string;
      readonly verified?: boolean;
      readonly pubkey?: string;
      readonly nonce?: string;
      readonly sig?: string;
    };
    const harness = typeof hello.harness === 'string' ? hello.harness : 'unknown';
    return { ...hello, harness };
  }
  return parsed as Frame;
}

/**
 * Multiplexed stream reader: peel zero or more complete frames (binary
 * media-chunks AND newline-JSON control frames) off a growable Buffer.
 *
 * Returns the frames parsed and the leftover (incomplete) tail buffer.
 * Unknown / malformed frames are dropped (same discipline as parseFrame).
 */
export function pullFramesFromBuffer(buf: Buffer): { frames: Frame[]; rest: Buffer } {
  const { frames, rest } = corePullFramesFromBuffer(buf, parseFrame);
  // Binary chunks arrive as BinaryMediaChunkFrame, which is assignable to Frame.
  return { frames: frames as Frame[], rest };
}
