/** Live-session wire frames.
 *
 *  Control / text frames (hello, msg, typing, bye, media-start, media-end,
 *  rtc-*) stay newline-JSON. Media CHUNK payloads travel as raw binary on the
 *  same socket (see {@link serializeBinaryMediaChunk}) so we avoid the ~33%
 *  base64 tax and the per-chunk JSON envelope.
 *
 *  Same allowlist discipline as p2p.parseHandshake: build results key-by-key,
 *  cap sizes, drop unknown frame types — a peer can never leak extra fields. */
export const MAX_TEXT_LEN = 4000;
export const MAX_ID_LEN = 64;
/** Largest base64 payload permitted in a legacy JSON `media-chunk` frame. */
export const MAX_B64_CHUNK_LEN = 16 * 1024; // 16 KiB
/** Largest raw payload permitted in a binary media-chunk frame. */
export const MAX_BINARY_CHUNK_BYTES = 64 * 1024; // 64 KiB
/** Largest total media transfer permitted (`media-start.size`, and reassembly). */
export const MAX_MEDIA_SIZE = 25 * 1024 * 1024; // 25 MiB
/** Largest `media-start.mime` string accepted. */
export const MAX_MIME_LEN = 128;
/** Largest `media-start.name` string accepted. */
export const MAX_NAME_LEN = 256;
/** Largest `sdp` string accepted on an `rtc-offer` / `rtc-answer` frame.
 *  Browser SDP blobs are typically 1-4 KiB; 64 KiB is a generous ceiling that
 *  still keeps a single signaling line cheap to buffer and parse. */
export const MAX_SDP_LEN = 64 * 1024; // 64 KiB
/** Largest `candidate` string accepted on an `rtc-ice` frame. ICE candidate
 *  lines are tiny (<1 KiB); 4 KiB is a generous ceiling. */
export const MAX_CANDIDATE_LEN = 4 * 1024; // 4 KiB
/**
 * Per-line cap sized to admit the LARGEST legal JSON frame AFTER escaping:
 *  - a max `rtc-offer` / `rtc-answer` carries a MAX_SDP_LEN-char sdp, which
 *    JSON.stringify can AT MOST double (every char escaped, e.g. CR/LF → \r\n),
 *    so its worst-case wire form is ~2*MAX_SDP_LEN bytes plus the wrapper;
 *  - a legacy JSON `media-chunk` is ~MAX_B64_CHUNK_LEN chars of base64.
 * Binary media-chunks are NOT newline-JSON and do not use this cap — they are
 * bounded by {@link MAX_BINARY_CHUNK_BYTES} via the length-prefixed binary header.
 */
const MAX_FRAME_LEN = Math.max(MAX_B64_CHUNK_LEN, 2 * MAX_SDP_LEN) + 2048;

/**
 * Leading byte of a binary media-chunk frame on the multiplexed socket.
 * Chosen so it can never be mistaken for the start of a newline-JSON frame
 * (those always begin with `{` = 0x7b for our allowlisted shapes).
 */
export const BIN_MEDIA_CHUNK_TAG = 0x01;

/** Exact hex length of an ed25519 raw public key on a `hello` frame. */
export const HELLO_PUBKEY_HEX_LEN = 64;
/** Exact hex length of an ed25519 signature on a `hello` frame. */
export const HELLO_SIG_HEX_LEN = 128;
/** Largest hex nonce accepted on a `hello` frame (16 random bytes = 32). */
export const MAX_HELLO_NONCE_HEX_LEN = 64;

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
  return JSON.stringify(f);
}

export function parseFrame(raw: string | Buffer): Frame | null {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  if (text.length > MAX_FRAME_LEN) return null;
  let d: unknown;
  try { d = JSON.parse(text); } catch { return null; }
  if (typeof d !== 'object' || d === null || Array.isArray(d)) return null;
  const r = d as Record<string, unknown>;
  switch (r['t']) {
    case 'bye': return { t: 'bye' };
    case 'typing': return { t: 'typing' };
    case 'hello': {
      const { handle, league, harness } = r;
      if (typeof handle !== 'string' || typeof league !== 'string') return null;
      // `verified` is optional (legacy peers omit it) but strictly boolean when
      // present — it is the self-asserted usage-verification flag, carried so
      // same-league peers can show an honest ✓ / ~ mark.
      const verified = r['verified'];
      if (verified !== undefined && typeof verified !== 'boolean') return null;
      // Identity proof is optional too (legacy peers), but when any of it is
      // present it must be exactly-shaped hex: a malformed claim is a broken or
      // hostile peer, and the whole frame is dropped. Whether a well-formed
      // claim actually VERIFIES is decided one layer up (identity.ts).
      const pubkey = r['pubkey'];
      if (
        pubkey !== undefined &&
        (typeof pubkey !== 'string' || !/^[0-9a-fA-F]{64}$/.test(pubkey))
      )
        return null;
      const nonce = r['nonce'];
      if (
        nonce !== undefined &&
        (typeof nonce !== 'string' || !/^[0-9a-fA-F]{1,64}$/.test(nonce))
      )
        return null;
      const sig = r['sig'];
      if (
        sig !== undefined &&
        (typeof sig !== 'string' || !/^[0-9a-fA-F]{128}$/.test(sig))
      )
        return null;
      return {
        t: 'hello',
        handle,
        league,
        harness: typeof harness === 'string' ? harness : 'unknown',
        ...(typeof verified === 'boolean' ? { verified } : {}),
        ...(typeof pubkey === 'string' ? { pubkey } : {}),
        ...(typeof nonce === 'string' ? { nonce } : {}),
        ...(typeof sig === 'string' ? { sig } : {}),
      };
    }
    case 'msg': {
      const id = r['id']; const txt = r['text']; const at = r['at'];
      if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_LEN) return null;
      if (typeof txt !== 'string' || txt.length === 0 || txt.length > MAX_TEXT_LEN) return null;
      if (typeof at !== 'number' || !Number.isFinite(at)) return null;
      return { t: 'msg', id, text: txt, at };
    }
    case 'media-start': {
      const id = r['id']; const mime = r['mime']; const size = r['size']; const name = r['name'];
      if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_LEN) return null;
      if (typeof mime !== 'string' || mime.length > MAX_MIME_LEN) return null;
      if (typeof name !== 'string' || name.length > MAX_NAME_LEN) return null;
      // size is a byte count: finite, a non-negative integer, within the cap.
      if (
        typeof size !== 'number' ||
        !Number.isFinite(size) ||
        !Number.isInteger(size) ||
        size < 0 ||
        size > MAX_MEDIA_SIZE
      )
        return null;
      return { t: 'media-start', id, mime, size, name };
    }
    case 'media-chunk': {
      const id = r['id']; const seq = r['seq']; const b64 = r['b64'];
      if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_LEN) return null;
      // seq is an index: finite, a non-negative integer.
      if (typeof seq !== 'number' || !Number.isFinite(seq) || !Number.isInteger(seq) || seq < 0)
        return null;
      if (typeof b64 !== 'string' || b64.length === 0 || b64.length > MAX_B64_CHUNK_LEN) return null;
      return { t: 'media-chunk', id, seq, b64 };
    }
    case 'media-end': {
      const id = r['id'];
      if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_LEN) return null;
      return { t: 'media-end', id };
    }
    case 'rtc-offer': {
      const sdp = r['sdp'];
      if (typeof sdp !== 'string' || sdp.length === 0 || sdp.length > MAX_SDP_LEN) return null;
      return { t: 'rtc-offer', sdp };
    }
    case 'rtc-answer': {
      const sdp = r['sdp'];
      if (typeof sdp !== 'string' || sdp.length === 0 || sdp.length > MAX_SDP_LEN) return null;
      return { t: 'rtc-answer', sdp };
    }
    case 'rtc-ice': {
      const candidate = r['candidate'];
      // An empty candidate string is a legal trickle-ICE "end of gathering"
      // marker, so only the upper bound is enforced here (no minimum length).
      if (typeof candidate !== 'string' || candidate.length > MAX_CANDIDATE_LEN) return null;
      return { t: 'rtc-ice', candidate };
    }
    default: return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Binary media-chunk framing (multiplexed with newline-JSON on one socket)   */
/* -------------------------------------------------------------------------- */

/**
 * On-wire layout for a binary media-chunk frame:
 *
 *   [tag:u8=0x01][hdrLen:u16BE][payloadLen:u32BE][hdr_json_utf8][payload_bytes]
 *
 * `hdr_json` is a tiny allowlisted JSON object `{"id":"…","seq":N}` (no
 * payload, no extra keys). `payload_bytes` is the raw media slice — never
 * base64, never JSON-escaped.
 *
 * The tag byte 0x01 cannot start a legal JSON control frame (those begin with
 * `{` = 0x7b), so a byte-oriented mux demuxes binary vs JSON unambiguously:
 * if the next buffered byte is BIN_MEDIA_CHUNK_TAG, parse a binary frame featuring
 * the length-prefix; otherwise accumulate until `\n` and parseFrame.
 */

export interface BinaryMediaChunkParts {
  readonly id: string;
  readonly seq: number;
  readonly data: Buffer;
}

/** Serialize one binary media-chunk frame. Throws on cap / shape violations. */
export function serializeBinaryMediaChunk(parts: BinaryMediaChunkParts): Buffer {
  const { id, seq, data } = parts;
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_LEN) {
    throw new Error(`invalid media chunk id length: ${typeof id === 'string' ? id.length : '?'}`);
  }
  if (typeof seq !== 'number' || !Number.isFinite(seq) || !Number.isInteger(seq) || seq < 0) {
    throw new Error(`invalid media chunk seq: ${String(seq)}`);
  }
  if (!Buffer.isBuffer(data) || data.length === 0 || data.length > MAX_BINARY_CHUNK_BYTES) {
    throw new Error(
      `invalid media chunk payload length: ${Buffer.isBuffer(data) ? data.length : 'n/a'}`,
    );
  }
  // Tiny allowlisted header ONLY — never put payload or extra fields here.
  const hdr = Buffer.from(JSON.stringify({ id, seq }), 'utf8');
  if (hdr.length > 0xffff) throw new Error(`media chunk header too large: ${hdr.length}`);
  const out = Buffer.allocUnsafe(1 + 2 + 4 + hdr.length + data.length);
  let o = 0;
  out[o++] = BIN_MEDIA_CHUNK_TAG;
  out.writeUInt16BE(hdr.length, o); o += 2;
  out.writeUInt32BE(data.length, o); o += 4;
  hdr.copy(out, o); o += hdr.length;
  data.copy(out, o);
  return out;
}

/**
 * Try to parse one complete binary media-chunk from the front of `buf`.
 *
 * Returns:
 *   - `{ frame, bytesConsumed }` on a complete valid frame
 *   - `{ frame: null, bytesConsumed: 0 }` if more bytes are needed (or buf empty
 *     / not starting with the binary tag)
 *   - `{ frame: null, bytesConsumed: n>0 }` when the leading bytes are a
 *     corrupt binary frame that should be skipped (bad lengths / header)
 *
 * Never throws.
 */
export function tryParseBinaryMediaChunk(
  buf: Buffer,
): { frame: BinaryMediaChunkFrame | null; bytesConsumed: number } {
  if (buf.length === 0) return { frame: null, bytesConsumed: 0 };
  if (buf[0] !== BIN_MEDIA_CHUNK_TAG) return { frame: null, bytesConsumed: 0 };
  // Need the fixed prefix: tag(1) + hdrLen(2) + payloadLen(4) = 7 bytes.
  if (buf.length < 7) return { frame: null, bytesConsumed: 0 };
  const hdrLen = buf.readUInt16BE(1);
  const payloadLen = buf.readUInt32BE(3);
  // Reject absurd lengths early so a hostile peer can't force a huge alloc.
  // hdr is a tiny {"id","seq"} JSON; anything past a few hundred bytes is junk.
  const MAX_HDR_LEN = 512;
  if (hdrLen === 0 || hdrLen > MAX_HDR_LEN || payloadLen === 0 || payloadLen > MAX_BINARY_CHUNK_BYTES) {
    // Skip just the tag so the mux can resync on the next byte.
    return { frame: null, bytesConsumed: 1 };
  }
  const total = 7 + hdrLen + payloadLen;
  if (buf.length < total) return { frame: null, bytesConsumed: 0 };

  const hdrBuf = buf.subarray(7, 7 + hdrLen);
  let hdrObj: unknown;
  try {
    hdrObj = JSON.parse(hdrBuf.toString('utf8'));
  } catch {
    return { frame: null, bytesConsumed: 1 };
  }
  if (typeof hdrObj !== 'object' || hdrObj === null || Array.isArray(hdrObj)) {
    return { frame: null, bytesConsumed: 1 };
  }
  const r = hdrObj as Record<string, unknown>;
  const id = r['id'];
  const seq = r['seq'];
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_LEN) {
    return { frame: null, bytesConsumed: 1 };
  }
  if (typeof seq !== 'number' || !Number.isFinite(seq) || !Number.isInteger(seq) || seq < 0) {
    return { frame: null, bytesConsumed: 1 };
  }
  // Copy payload so the caller's buffer can be compacted without aliasing.
  const data = Buffer.from(buf.subarray(7 + hdrLen, 7 + hdrLen + payloadLen));
  return {
    frame: { t: 'media-chunk', id, seq, data },
    bytesConsumed: total,
  };
}

/**
 * Multiplexed stream reader: peel zero or more complete frames (binary
 * media-chunks AND newline-JSON control frames) off a growable Buffer.
 *
 * Returns the frames parsed and the leftover (incomplete) tail buffer.
 * Unknown / malformed frames are dropped (same discipline as parseFrame).
 */
export function pullFramesFromBuffer(buf: Buffer): { frames: Frame[]; rest: Buffer } {
  const frames: Frame[] = [];
  let offset = 0;

  while (offset < buf.length) {
    const first = buf[offset]!;

    // Binary media-chunk path.
    if (first === BIN_MEDIA_CHUNK_TAG) {
      const slice = offset === 0 ? buf : buf.subarray(offset);
      const { frame, bytesConsumed } = tryParseBinaryMediaChunk(slice);
      if (bytesConsumed === 0) {
        // Incomplete binary frame (or empty) — need more bytes.
        break;
      }
      if (frame !== null) frames.push(frame);
      offset += bytesConsumed;
      continue;
    }

    // Newline-JSON control/text path. JSON frames start with '{' in practice;
    // anything else before a newline is garbage and will be dropped by parseFrame.
    const nlRel = buf.indexOf(0x0a /* \n */, offset);
    if (nlRel < 0) {
      // No complete line yet.
      break;
    }
    const lineBuf = buf.subarray(offset, nlRel);
    offset = nlRel + 1;
    if (lineBuf.length === 0) continue;
    // Skip pure-whitespace lines without paying for toString on big empty runs.
    let onlyWs = true;
    for (let i = 0; i < lineBuf.length; i++) {
      const c = lineBuf[i]!;
      if (c !== 0x20 && c !== 0x09 && c !== 0x0d) {
        onlyWs = false;
        break;
      }
    }
    if (onlyWs) continue;
    const frame = parseFrame(lineBuf);
    if (frame !== null) frames.push(frame);
  }

  const rest = offset === 0 ? buf : buf.subarray(offset);
  // Copy the remainder so callers can discard the original oversized buffer.
  return { frames, rest: rest.length === 0 ? Buffer.alloc(0) : Buffer.from(rest) };
}
