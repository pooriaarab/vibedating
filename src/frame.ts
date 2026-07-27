/** Live-session wire frames. Newline-JSON over the hyperswarm socket.
 *  Same allowlist discipline as p2p.parseHandshake: build results key-by-key,
 *  cap sizes, drop unknown frame types — a peer can never leak extra fields. */
export const MAX_TEXT_LEN = 4000;
const MAX_ID_LEN = 64;
const MAX_FRAME_LEN = 8192;

export type Frame =
  | { t: 'hello'; handle: string; league: string; harness: string }
  | { t: 'msg'; id: string; text: string; at: number }
  | { t: 'typing' }
  | { t: 'bye' };

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
    default: return null;
  }
}
