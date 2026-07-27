import { describe, expect, it } from 'vitest';
import {
  MAX_B64_CHUNK_LEN,
  MAX_MEDIA_SIZE,
  MAX_MIME_LEN,
  MAX_NAME_LEN,
  parseFrame,
  serializeFrame,
  type Frame,
} from './frame.js';

describe('frame protocol', () => {
  it('round-trips a msg frame', () => {
    const f: Frame = { t: 'msg', id: 'a1', text: 'hi', at: 1 };
    expect(parseFrame(serializeFrame(f))).toEqual(f);
  });
  it('rejects unknown type', () => {
    expect(parseFrame(JSON.stringify({ t: 'evil', text: 'x' }))).toBeNull();
  });
  it('drops extra keys (allowlist)', () => {
    const raw = JSON.stringify({ t: 'msg', id: 'a', text: 'hi', at: 1, leak: 'raw-usage' });
    expect(parseFrame(raw)).toEqual({ t: 'msg', id: 'a', text: 'hi', at: 1 });
  });
  it('caps text length', () => {
    expect(parseFrame(JSON.stringify({ t: 'msg', id: 'a', text: 'x'.repeat(5000), at: 1 }))).toBeNull();
  });
  it('parses hello/typing/bye', () => {
    expect(parseFrame(JSON.stringify({ t: 'bye' }))).toEqual({ t: 'bye' });
    expect(parseFrame(JSON.stringify({ t: 'typing' }))).toEqual({ t: 'typing' });
  });
});

describe('frame protocol — media frames', () => {
  it('round-trips a media-start frame', () => {
    const f: Frame = { t: 'media-start', id: 'm1', mime: 'image/png', size: 1234, name: 'cat.png' };
    expect(parseFrame(serializeFrame(f))).toEqual(f);
  });
  it('round-trips a media-chunk frame', () => {
    const f: Frame = { t: 'media-chunk', id: 'm1', seq: 0, b64: 'aGVsbG8=' };
    expect(parseFrame(serializeFrame(f))).toEqual(f);
  });
  it('round-trips a media-end frame', () => {
    const f: Frame = { t: 'media-end', id: 'm1' };
    expect(parseFrame(serializeFrame(f))).toEqual(f);
  });

  it('drops extra keys on a media-start frame (allowlist)', () => {
    const raw = JSON.stringify({
      t: 'media-start',
      id: 'm1',
      mime: 'image/png',
      size: 10,
      name: 'a.png',
      leak: 'raw-usage',
    });
    expect(parseFrame(raw)).toEqual({
      t: 'media-start',
      id: 'm1',
      mime: 'image/png',
      size: 10,
      name: 'a.png',
    });
  });
  it('drops extra keys on a media-chunk frame (allowlist)', () => {
    const raw = JSON.stringify({
      t: 'media-chunk',
      id: 'm1',
      seq: 2,
      b64: 'AAAA',
      leak: 'raw-usage',
    });
    expect(parseFrame(raw)).toEqual({ t: 'media-chunk', id: 'm1', seq: 2, b64: 'AAAA' });
  });

  it('rejects media-start with size over the 25 MiB cap', () => {
    expect(
      parseFrame(
        JSON.stringify({ t: 'media-start', id: 'm', mime: 'image/png', size: MAX_MEDIA_SIZE + 1, name: 'a.png' }),
      ),
    ).toBeNull();
  });
  it('rejects media-start with a negative / non-integer / non-finite size', () => {
    const base = { t: 'media-start', id: 'm', mime: 'image/png', name: 'a.png' } as const;
    expect(parseFrame(JSON.stringify({ ...base, size: -1 }))).toBeNull();
    expect(parseFrame(JSON.stringify({ ...base, size: 1.5 }))).toBeNull();
    // JSON.stringify(NaN) -> null, so spell the bad size via a raw string
    expect(parseFrame('{"t":"media-start","id":"m","mime":"image/png","size":NaN,"name":"a.png"}')).toBeNull();
  });
  it('rejects media-start with oversized mime / name', () => {
    const ok = { t: 'media-start', id: 'm', size: 1, name: 'a.png' } as const;
    expect(
      parseFrame(JSON.stringify({ ...ok, mime: 'x'.repeat(MAX_MIME_LEN + 1) })),
    ).toBeNull();
    const ok2 = { t: 'media-start', id: 'm', size: 1, mime: 'image/png' } as const;
    expect(
      parseFrame(JSON.stringify({ ...ok2, name: 'x'.repeat(MAX_NAME_LEN + 1) })),
    ).toBeNull();
  });

  it('rejects media-chunk with b64 over the 16 KiB cap', () => {
    expect(
      parseFrame(
        JSON.stringify({ t: 'media-chunk', id: 'm', seq: 0, b64: 'A'.repeat(MAX_B64_CHUNK_LEN + 1) }),
      ),
    ).toBeNull();
  });
  it('rejects media-chunk with a non-finite / non-integer / negative seq', () => {
    const base = { t: 'media-chunk', id: 'm', b64: 'AAAA' } as const;
    expect(parseFrame(JSON.stringify({ ...base, seq: '0' }))).toBeNull();
    expect(parseFrame(JSON.stringify({ ...base, seq: 1.5 }))).toBeNull();
    expect(parseFrame(JSON.stringify({ ...base, seq: -1 }))).toBeNull();
    expect(parseFrame('{"t":"media-chunk","id":"m","seq":NaN,"b64":"AAAA"}')).toBeNull();
  });

  it('rejects media frames missing required keys', () => {
    expect(parseFrame(JSON.stringify({ t: 'media-start', id: 'm', mime: 'x', name: 'y' }))).toBeNull(); // no size
    expect(parseFrame(JSON.stringify({ t: 'media-chunk', id: 'm', seq: 0 }))).toBeNull(); // no b64
    expect(parseFrame(JSON.stringify({ t: 'media-end' }))).toBeNull(); // no id
  });

  it('admits a maximum-size media-chunk (16 KiB b64) within the frame cap', () => {
    const f = { t: 'media-chunk', id: 'm', seq: 0, b64: 'A'.repeat(MAX_B64_CHUNK_LEN) };
    expect(parseFrame(serializeFrame(f as unknown as Frame))).toEqual(f);
  });
});
