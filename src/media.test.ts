import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_MEDIA_SIZE, parseFrame, type MediaFrame } from './frame.js';
import {
  DEFAULT_CHUNK_BYTES,
  MediaReceiver,
  sendMedia,
  sendMediaFile,
  type ReceivedMedia,
} from './media.js';

const isChunk = (l: string): boolean => l.includes('"media-chunk"');
const isStart = (l: string): boolean => l.includes('"media-start"');
const isEnd = (l: string): boolean => l.includes('"media-end"');

/**
 * Build a fake socket: an EventEmitter with a `write` that records each line.
 * `backpressure=false` (default) is the fast path (write returns true);
 * `backpressure=true` returns false on every write so the test can prove the
 * sender waits for a hand-emitted 'drain' before its next frame.
 */
function fakeSocket(backpressure = false): Duplex & { lines: string[]; emit: EventEmitter['emit'] } {
  const obj = Object.assign(new EventEmitter(), {
    lines: [] as string[],
    write(this: { lines: string[] }, line: string): boolean {
      this.lines.push(line);
      return !backpressure;
    },
  });
  return obj as unknown as Duplex & { lines: string[]; emit: EventEmitter['emit'] };
}

/** Drive every recorded frame through a fresh MediaReceiver, returning the
 *  ReceivedMedia list (in delivery order). */
function reassemble(lines: string[], tmpDir: string): ReceivedMedia[] {
  const got: ReceivedMedia[] = [];
  const rx = new MediaReceiver((m) => got.push(m), { tmpDir });
  for (const line of lines) {
    const frame = parseFrame(line.trimEnd());
    if (frame !== null) rx.handle(frame as MediaFrame);
  }
  return got;
}

/** Yield once to the microtask queue so an awaited resolved promise resumes. */
const tick = () => new Promise<void>((r) => queueMicrotask(r));

describe('media — chunking + reassembly round-trip', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'vibedating-media-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('round-trips a small buffer through one chunk', async () => {
    const socket = fakeSocket();
    const data = Buffer.from('hello media world', 'utf8');
    const { id, size } = await sendMedia({ socket, data, mime: 'text/plain', name: 'greet.txt' });

    expect(size).toBe(data.length);
    expect(id.length).toBeGreaterThan(0);
    expect(socket.lines.filter(isStart).length).toBe(1);
    expect(socket.lines.filter(isChunk).length).toBe(1);
    expect(socket.lines.filter(isEnd).length).toBe(1);

    const got = reassemble(socket.lines, tmpDir);
    expect(got.length).toBe(1);
    expect(got[0]!.mime).toBe('text/plain');
    expect(got[0]!.name).toBe('greet.txt');
    expect(got[0]!.size).toBe(data.length);
    expect(readFileSync(got[0]!.path)).toEqual(data);
  });

  it('round-trips a multi-chunk buffer (>= DEFAULT_CHUNK_BYTES) keeping order', async () => {
    const socket = fakeSocket();
    // ~3 chunks at DEFAULT_CHUNK_BYTES (12288), pseudo-random bytes so they
    // don't trivially compress in any future b64-related change.
    const data = Buffer.alloc(DEFAULT_CHUNK_BYTES * 2 + 1234);
    for (let i = 0; i < data.length; i++) data[i] = (i * 31 + 7) & 0xff;

    const { size } = await sendMedia({
      socket,
      data,
      mime: 'application/octet-stream',
      name: 'blob.bin',
    });
    expect(size).toBe(data.length);
    expect(socket.lines.filter(isChunk).length).toBe(3); // 12288 + 12288 + 1234

    const got = reassemble(socket.lines, tmpDir);
    expect(got.length).toBe(1);
    expect(readFileSync(got[0]!.path)).toEqual(data);
    expect(got[0]!.size).toBe(data.length);
  });

  it('sendMediaFile reads a file, infers mime from extension, round-trips', async () => {
    const socket = fakeSocket();
    const filePath = path.join(tmpDir, 'pic.png');
    const data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    writeFileSync(filePath, data);

    await sendMediaFile({ socket, path: filePath });

    const got = reassemble(socket.lines, tmpDir);
    expect(got.length).toBe(1);
    expect(got[0]!.mime).toBe('image/png');
    expect(got[0]!.name).toBe('pic.png');
    expect(readFileSync(got[0]!.path)).toEqual(data);
  });
});

describe('media — caps + rejection', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'vibedating-media-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sendMedia rejects a buffer over the 25 MiB cap', async () => {
    const socket = fakeSocket();
    await expect(
      sendMedia({
        socket,
        data: Buffer.alloc(MAX_MEDIA_SIZE + 1),
        mime: 'application/octet-stream',
        name: 'big.bin',
      }),
    ).rejects.toThrow(/too large/);
  });

  it('receiver rejects a transfer whose running total exceeds the declared size', async () => {
    // Ship 8 real bytes but lie that size is 4 — the receiver must abort.
    const socket = fakeSocket();
    await sendMedia({ socket, data: Buffer.from('12345678', 'utf8'), mime: 'text/plain', name: 'x.txt' });
    const tampered = socket.lines.map((line) =>
      isStart(line) ? line.replace('"size":8', '"size":4') : line,
    );
    expect(reassemble(tampered, tmpDir).length).toBe(0);
  });

  it('receiver rejects a duplicate / out-of-order seq', async () => {
    const socket = fakeSocket();
    await sendMedia({
      socket,
      data: Buffer.from('abcdefgh', 'utf8'),
      mime: 'text/plain',
      name: 'x.txt',
      chunkBytes: 4,
    });
    // Rewrite the second chunk's seq from 1 -> 0 so it duplicates seq 0.
    const tampered = socket.lines.map((line) =>
      line.includes('"seq":1') ? line.replace('"seq":1', '"seq":0') : line,
    );
    expect(reassemble(tampered, tmpDir).length).toBe(0);
  });

  it('receiver drops media-end for an incomplete transfer', async () => {
    const socket = fakeSocket();
    await sendMedia({
      socket,
      data: Buffer.from('abcdefgh', 'utf8'),
      mime: 'text/plain',
      name: 'x.txt',
      chunkBytes: 4,
    });
    // Remove the second chunk entirely, keep media-end -> incomplete.
    const lines = socket.lines.filter((l) => !l.includes('"seq":1'));
    expect(reassemble(lines, tmpDir).length).toBe(0);
  });

  it('receiver ignores a media-chunk with no preceding media-start', () => {
    const got: ReceivedMedia[] = [];
    const rx = new MediaReceiver((m) => got.push(m), { tmpDir });
    const orphan = parseFrame(
      JSON.stringify({ t: 'media-chunk', id: 'orphan', seq: 0, b64: 'AAAA' }),
    ) as MediaFrame;
    rx.handle(orphan);
    expect(got.length).toBe(0);
  });
});

describe('media — backpressure', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'vibedating-media-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * A gated socket: every write returns false, and the sender must wait for a
   * manually-emitted 'drain' before its next write. If sendMedia honored
   * backpressure, each 'drain' advances exactly ONE frame; if it ignored it,
   * all frames would be written immediately regardless of drain.
   */
    function gatedSocket(): Duplex & { lines: string[]; emit: EventEmitter['emit'] } {
    return fakeSocket(true);
  }

  it('awaits drain between every frame (one drain advances exactly one frame)', async () => {
    const socket = gatedSocket();
    const data = Buffer.alloc(DEFAULT_CHUNK_BYTES * 2 + 5); // -> 3 chunks
    for (let i = 0; i < data.length; i++) data[i] = (i * 7) & 0xff;

    const sendP = sendMedia({ socket, data, mime: 'application/octet-stream', name: 'bp.bin' });

    // Synchronously the sender writes media-start, then parks on drain #1.
    // No chunk has been written yet.
    await tick();
    expect(socket.lines.filter(isStart).length).toBe(1);
    expect(socket.lines.filter(isChunk).length).toBe(0);

    // Each emitted 'drain' releases exactly one more frame.
    socket.emit('drain'); // media-start drain -> chunk 0
    await tick();
    expect(socket.lines.filter(isChunk).length).toBe(1);

    socket.emit('drain'); // chunk 0 drain -> chunk 1
    await tick();
    expect(socket.lines.filter(isChunk).length).toBe(2);

    socket.emit('drain'); // chunk 1 drain -> chunk 2
    await tick();
    expect(socket.lines.filter(isChunk).length).toBe(3);

    socket.emit('drain'); // chunk 2 drain -> media-end
    await tick();
    expect(socket.lines.filter(isEnd).length).toBe(1);

    socket.emit('drain'); // media-end drain -> sendMedia resolves
    await sendP;

    // Despite full backpressure, the reassembled bytes still round-trip exactly.
    const got = reassemble(socket.lines, tmpDir);
    expect(got.length).toBe(1);
    expect(readFileSync(got[0]!.path)).toEqual(data);
  });

  it('does not await drain when writes return true (fast path)', async () => {
    const socket = fakeSocket();
    await sendMedia({
      socket,
      data: Buffer.alloc(DEFAULT_CHUNK_BYTES * 2 + 1),
      mime: 'application/octet-stream',
      name: 'fast.bin',
    });
    // No 'drain' listener was ever needed; all frames are on the wire.
    expect(socket.lines.filter(isStart).length).toBe(1);
    expect(socket.lines.filter(isChunk).length).toBeGreaterThanOrEqual(1);
    expect(socket.lines.filter(isEnd).length).toBe(1);
  });
});
