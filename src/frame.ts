/** Live-session wire frames. Newline-JSON over the hyperswarm socket.
 *  Same allowlist discipline as p2p.parseHandshake: build results key-by-key,
 *  cap sizes, drop unknown frame types — a peer can never leak extra fields. */
export const MAX_TEXT_LEN = 4000;
const MAX_ID_LEN = 64;
/** Largest base64 payload permitted in a single `media-chunk` frame. */
export const MAX_B64_CHUNK_LEN = 16 * 1024; // 16 KiB
/** Largest total media transfer permitted (`media-start.size`, and reassembly). */
export const MAX_MEDIA_SIZE = 25 * 1024 * 1024; // 25 MiB
/** Largest `media-start.mime` string accepted. */
export const MAX_MIME_LEN = 128;
/** Largest `media-start.name` string accepted. */
export const MAX_NAME_LEN = 256;
/** Per-line cap sized to admit the largest legal frame (a max `media-chunk`
 *  is ~MAX_B64_CHUNK_LEN bytes of b64 plus the JSON wrapper). */
const MAX_FRAME_LEN = MAX_B64_CHUNK_LEN + 1024;

export type Frame =
  | { t: 'hello'; handle: string; league: string; harness: string }
  | { t: 'msg'; id: string; text: string; at: number }
  | { t: 'typing' }
  | { t: 'bye' }
  | { t: 'media-start'; id: string; mime: string; size: number; name: string }
  | { t: 'media-chunk'; id: string; seq: number; b64: string }
  | { t: 'media-end'; id: string };

/** Convenience union of the three media-transfer frame types. */
export type MediaFrame = Extract<Frame, { t: `media-${string}` }>;

export function serializeFrame(f: Frame): string {
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
      return { t: 'hello', handle, league, harness: typeof harness === 'string' ? harness : 'unknown' };
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
    default: return null;
  }
}
