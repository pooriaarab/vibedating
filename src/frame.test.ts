import { describe, expect, it } from 'vitest';
import { parseFrame, serializeFrame, type Frame } from './frame.js';

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
