import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_MEDIA_SIZE,
  parseFrame,
  pullFramesFromBuffer,
  type MediaFrame,
} from './frame.js';
import {
  DEFAULT_CHUNK_BYTES,
  MediaReceiver,
  sendMedia,
  sendMediaFile,
  type ReceivedMedia,
} from '@pooriaarab/vibe-core/media';

/**
 * Build a fake sink: an EventEmitter with a `write` that records each write
 * as a Buffer. `backpressure=false` (default) is the fast path (write returns
 * true); `backpressure=true` returns false on every write so the test can prove
 * the sender waits for a hand-emitted 'drain' before its next frame.
 */
function fakeSocket(
  backpressure = false,
): Duplex & { chunks: Buffer[]; emit: EventEmitter['emit'] } {
  const obj = Object.assign(new EventEmitter(), {
    chunks: [] as Buffer[],
    write(this: { chunks: Buffer[] }, data: string | Buffer): boolean {
      this.chunks.push(typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data));
      return !backpressure;
    },
  });
  return obj as unknown as Duplex & { chunks: Buffer[]; emit: EventEmitter['emit'] };
}

/** Concatenate recorded writes and peel every multiplexed frame off. */
function recordedFrames(chunks: Buffer[]): MediaFrame[] {
  const buf = Buffer.concat(chunks);
  const { frames } = pullFramesFromBuffer(buf);
  return frames.filter(
    (f): f is MediaFrame =>
      f.t === 'media-start' || f.t === 'media-chunk' || f.t === 'media-end',
  );
}

function countType(frames: MediaFrame[], t: MediaFrame['t']): number {
  return frames.filter((f) => f.t === t).length;
}

/** Drive every recorded media frame through a MediaReceiver. */
function reassemble(chunks: Buffer[], tmpDir: string): ReceivedMedia[] {
  const got: ReceivedMedia[] = [];
  const rx = new MediaReceiver((m) => got.push(m), { tmpDir });
  for (const frame of recordedFrames(chunks)) rx.handle(frame);
  return got;
}

/** Yield once to the microtask queue so an awaited resolved promise resumes. */
const tick = () => new Promise<void>((r) => queueMicrotask(r));

describe('media — chunking + reassembly round-trip (binary wire)', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'vibedating-media-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('round-trips a small buffer through one binary chunk', async () => {
    const socket = fakeSocket();
    const data = Buffer.from('hello media world', 'utf8');
    const { id, size } = await sendMedia({ sink: socket, data, mime: 'text/plain', name: 'greet.txt' });

    expect(size).toBe(data.length);
    expect(id.length).toBeGreaterThan(0);
    const frames = recordedFrames(socket.chunks);
    expect(countType(frames, 'media-start')).toBe(1);
    expect(countType(frames, 'media-chunk')).toBe(1);
    expect(countType(frames, 'media-end')).toBe(1);
    // Binary path: chunk carries `data`, not `b64`.
    const chunk = frames.find((f) => f.t === 'media-chunk')!;
    expect('data' in chunk).toBe(true);
    expect('b64' in chunk).toBe(false);

    const got = reassemble(socket.chunks, tmpDir);
    expect(got.length).toBe(1);
    expect(got[0]!.mime).toBe('text/plain');
    expect(got[0]!.name).toBe('greet.txt');
    expect(got[0]!.size).toBe(data.length);
    expect(readFileSync(got[0]!.path)).toEqual(data);
  });

  it('round-trips a multi-chunk buffer (>= DEFAULT_CHUNK_BYTES) keeping order', async () => {
    const socket = fakeSocket();
    // ~3 chunks at DEFAULT_CHUNK_BYTES (64 KiB), pseudo-random bytes.
    const data = Buffer.alloc(DEFAULT_CHUNK_BYTES * 2 + 1234);
    for (let i = 0; i < data.length; i++) data[i] = (i * 31 + 7) & 0xff;

    const { size } = await sendMedia({
      sink: socket,
      data,
      mime: 'application/octet-stream',
      name: 'blob.bin',
    });
    expect(size).toBe(data.length);
    expect(countType(recordedFrames(socket.chunks), 'media-chunk')).toBe(3);

    const got = reassemble(socket.chunks, tmpDir);
    expect(got.length).toBe(1);
    expect(readFileSync(got[0]!.path)).toEqual(data);
    expect(got[0]!.size).toBe(data.length);
  });

  it('sendMediaFile reads a file, infers mime from extension, round-trips', async () => {
    const socket = fakeSocket();
    const filePath = path.join(tmpDir, 'pic.png');
    const data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    writeFileSync(filePath, data);

    await sendMediaFile({ sink: socket, path: filePath });

    const got = reassemble(socket.chunks, tmpDir);
    expect(got.length).toBe(1);
    expect(got[0]!.mime).toBe('image/png');
    expect(got[0]!.name).toBe('pic.png');
    expect(readFileSync(got[0]!.path)).toEqual(data);
  });

  it('still accepts legacy JSON/base64 chunks on the receiver', async () => {
    const socket = fakeSocket();
    const data = Buffer.from('legacy path still works', 'utf8');
    await sendMedia({
      sink: socket,
      data,
      mime: 'text/plain',
      name: 'leg.txt',
      legacyJson: true,
    });
    // Legacy writes are pure newline-JSON; every write should contain '"b64"'.
    const joined = Buffer.concat(socket.chunks).toString('utf8');
    expect(joined).toContain('"b64"');
    const got = reassemble(socket.chunks, tmpDir);
    expect(got.length).toBe(1);
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
        sink: socket,
        data: Buffer.alloc(MAX_MEDIA_SIZE + 1),
        mime: 'application/octet-stream',
        name: 'big.bin',
      }),
    ).rejects.toThrow(/too large/);
  });

  it('receiver rejects a transfer whose running total exceeds the declared size', async () => {
    // Ship 8 real bytes but lie that size is 4 — the receiver must abort.
    const socket = fakeSocket();
    await sendMedia({ sink: socket, data: Buffer.from('12345678', 'utf8'), mime: 'text/plain', name: 'x.txt' });
    // Tamper with media-start size on the JSON control frame portion.
    const wire = Buffer.concat(socket.chunks).toString('binary');
    const tampered = Buffer.from(wire.replace('"size":8', '"size":4'), 'binary');
    expect(reassemble([tampered], tmpDir).length).toBe(0);
  });

  it('receiver rejects a duplicate / out-of-order seq', async () => {
    const got: ReceivedMedia[] = [];
    const rx = new MediaReceiver((m) => got.push(m), { tmpDir });
    rx.handle({ t: 'media-start', id: 'x', mime: 'text/plain', size: 8, name: 'x.txt' });
    rx.handle({ t: 'media-chunk', id: 'x', seq: 0, data: Buffer.from('abcd') });
    // Duplicate seq 0 instead of 1.
    rx.handle({ t: 'media-chunk', id: 'x', seq: 0, data: Buffer.from('efgh') });
    rx.handle({ t: 'media-end', id: 'x' });
    expect(got.length).toBe(0);
  });

  it('receiver drops media-end for an incomplete transfer', async () => {
    const got: ReceivedMedia[] = [];
    const rx = new MediaReceiver((m) => got.push(m), { tmpDir });
    rx.handle({ t: 'media-start', id: 'x', mime: 'text/plain', size: 8, name: 'x.txt' });
    rx.handle({ t: 'media-chunk', id: 'x', seq: 0, data: Buffer.from('abcd') });
    // Missing second chunk — incomplete.
    rx.handle({ t: 'media-end', id: 'x' });
    expect(got.length).toBe(0);
  });

  it('receiver ignores a media-chunk with no preceding media-start', () => {
    const got: ReceivedMedia[] = [];
    const rx = new MediaReceiver((m) => got.push(m), { tmpDir });
    rx.handle({ t: 'media-chunk', id: 'orphan', seq: 0, data: Buffer.from([0, 0, 0]) });
    // Also the legacy shape.
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

  function gatedSocket(): Duplex & { chunks: Buffer[]; emit: EventEmitter['emit'] } {
    return fakeSocket(true);
  }

  it('awaits drain between every frame (one drain advances exactly one frame)', async () => {
    const socket = gatedSocket();
    // Small chunkBytes so we get exactly 3 binary chunks + start + end = 5 writes.
    const chunkBytes = 4;
    const data = Buffer.from('abcdefghijkl', 'utf8'); // 12 bytes → 3 chunks of 4

    const sendP = sendMedia({
      sink: socket,
      data,
      mime: 'application/octet-stream',
      name: 'bp.bin',
      chunkBytes,
    });

    // Synchronously the sender writes media-start, then parks on drain #1.
    await tick();
    expect(socket.chunks.length).toBe(1);
    expect(countType(recordedFrames(socket.chunks), 'media-start')).toBe(1);
    expect(countType(recordedFrames(socket.chunks), 'media-chunk')).toBe(0);

    socket.emit('drain'); // media-start drain -> chunk 0
    await tick();
    expect(countType(recordedFrames(socket.chunks), 'media-chunk')).toBe(1);

    socket.emit('drain'); // chunk 0 drain -> chunk 1
    await tick();
    expect(countType(recordedFrames(socket.chunks), 'media-chunk')).toBe(2);

    socket.emit('drain'); // chunk 1 drain -> chunk 2
    await tick();
    expect(countType(recordedFrames(socket.chunks), 'media-chunk')).toBe(3);

    socket.emit('drain'); // chunk 2 drain -> media-end
    await tick();
    expect(countType(recordedFrames(socket.chunks), 'media-end')).toBe(1);

    socket.emit('drain'); // media-end drain -> sendMedia resolves
    await sendP;

    const got = reassemble(socket.chunks, tmpDir);
    expect(got.length).toBe(1);
    expect(readFileSync(got[0]!.path)).toEqual(data);
  });

  it('rejects if socket closes before drain', async () => {
    const socket = gatedSocket();
    const data = Buffer.from('hello', 'utf8');
    const sendP = sendMedia({ sink: socket, data, mime: 'text/plain', name: 'close.txt' });

    await tick();
    socket.emit('close');
    await expect(sendP).rejects.toThrow(/Socket closed before drain/);
  });

  it('rejects if socket errors before drain', async () => {
    const socket = gatedSocket();
    const data = Buffer.from('hello', 'utf8');
    const sendP = sendMedia({ sink: socket, data, mime: 'text/plain', name: 'err.txt' });

    await tick();
    socket.emit('error', new Error('boom'));
    await expect(sendP).rejects.toThrow(/boom/);
  });

  it('receiver passes error to onMedia if writeFileSync fails', () => {
    const got: ReceivedMedia[] = [];
    const rx = new MediaReceiver((m) => got.push(m), { tmpDir: '/invalid/path/that/does/not/exist/12345' });
    const id = 'bad';
    rx.handle(parseFrame(`{"t":"media-start","id":"${id}","mime":"t","name":"t","size":1}`) as MediaFrame);
    rx.handle(parseFrame(`{"t":"media-chunk","id":"${id}","seq":0,"b64":"YQ=="}`) as MediaFrame);
    rx.handle(parseFrame(`{"t":"media-end","id":"${id}"}`) as MediaFrame);
    
    expect(got.length).toBe(1);
    expect(got[0]!.error).toBeInstanceOf(Error);
  });

  it('does not await drain when writes return true (fast path)', async () => {
    const socket = fakeSocket();
    await sendMedia({
      sink: socket,
      data: Buffer.alloc(DEFAULT_CHUNK_BYTES * 2 + 1),
      mime: 'application/octet-stream',
      name: 'fast.bin',
    });
    const frames = recordedFrames(socket.chunks);
    expect(countType(frames, 'media-start')).toBe(1);
    expect(countType(frames, 'media-chunk')).toBeGreaterThanOrEqual(1);
    expect(countType(frames, 'media-end')).toBe(1);
  });
});
