/**
 * Media-transfer integration test: TWO real hyperswarm nodes on an isolated
 * in-process DHT (hyperdht's createTestnet — the public DHT is never touched).
 *
 * Node A sends a small REAL PNG (~1.5 KiB) over its PeerLink; node B's
 * `onMedia` fires and the reassembled file on disk is byte-for-byte equal to
 * the original. This is the multi-machine proof for the media increment —
 * no unit test (which fakes the socket) can substitute for it.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import createTestnet from 'hyperdht/testnet.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  randomTopic,
  startDiscovery,
  type DiscoverySession,
  type PeerHello,
} from './p2p.js';
import type { PeerLink } from './link.js';
import { DEFAULT_CHUNK_BYTES, type ReceivedMedia } from '@pooriaarab/vibe-core/media';

const ALICE: PeerHello = { handle: '@alice_10M', league: '10M', harness: 'claude-code' };
const BOB: PeerHello = { handle: '@bob_10M', league: '10M', harness: 'codex' };

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return cond();
}

/* -------------------------------------------------------------------------- */
/* Minimal real PNG builder (signature + IHDR + IDAT + IEND, real CRC32)      */
/* -------------------------------------------------------------------------- */

const CRC_TABLE: readonly number[] = (() => {
  const t = new Array<number>(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Build a genuine, decodable PNG of `width`x`height` RGBA pixels. The pixel
 *  data is a deterministic high-entropy pattern so deflate does not shrink the
 *  IDAT away — yields a ~1-2 KiB file for the sizes used here. */
function buildPng(width: number, height: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const rowLen = 1 + width * 4; // filter byte + RGBA per pixel
  const raw = Buffer.alloc(rowLen * height);
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      raw[p++] = (x * 29 + y * 17) & 0xff; // R
      raw[p++] = (x * 53 + y * 97) & 0xff; // G
      raw[p++] = (x * 11 + y * 71) & 0xff; // B
      raw[p++] = (x * 83 + y * 41) & 0xff; // A
    }
  }
  const idat = deflateSync(raw);
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* -------------------------------------------------------------------------- */
/* Minimal valid MP4 builder (real ISO-BMFF box layout: ftyp + mdat)           */
/* -------------------------------------------------------------------------- */

function mp4Box(type: string, payload: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(payload.length + 8, 0);
  return Buffer.concat([len, Buffer.from(type, 'ascii'), payload]);
}

/**
 * Build a structurally valid MP4 (ISO-BMFF) file of approximately `targetBytes`.
 * Two genuine boxes: an `ftyp` (major brand `isom`, minor version 0x200) header,
 * then a single `mdat` carrying a deterministic high-entropy payload. The box
 * headers are real, so the file is a parseable MP4 container; the `mdat` is
 * sized so the whole file spans >= 3 chunks (DEFAULT_CHUNK_BYTES), exercising
 * seq ordering + reassembly rather than a one-chunk send. (Real decodable
 * video MEDIA is covered by the WebRTC integration test; here the point is the
 * multi-chunk file-transfer byte-equality over the P2P socket.)
 */
function buildMp4(targetBytes: number): Buffer {
  const ftypHead = Buffer.alloc(8);
  ftypHead.write('isom', 0, 'ascii'); // major brand
  ftypHead.writeUInt32BE(0x00000200, 4); // minor version
  const ftyp = mp4Box('ftyp', Buffer.concat([ftypHead, Buffer.from('isom', 'ascii')]));
  const mdatPayload = Buffer.alloc(Math.max(0, targetBytes - ftyp.length));
  // Deterministic 32-bit LCG → a reproducible, non-degenerate byte stream.
  let state = 0x1234abcd >>> 0;
  for (let i = 0; i < mdatPayload.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    mdatPayload[i] = state & 0xff;
  }
  return Buffer.concat([ftyp, mp4Box('mdat', mdatPayload)]);
}

describe('media transfer (in-process DHT, no public network)', () => {
  let testnet: Awaited<ReturnType<typeof createTestnet>>;
  let dirs: string[];
  let receivedPaths: string[];
  let sessions: DiscoverySession[];

  beforeEach(async () => {
    testnet = await createTestnet(3);
    dirs = [];
    receivedPaths = [];
    sessions = [];
  }, 30_000);

  afterEach(async () => {
    for (const s of sessions) await s.close();
    await testnet.destroy();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    for (const p of receivedPaths) rmSync(p, { force: true });
  }, 30_000);

  function tmpDir(): string {
    const d = mkdtempSync(path.join(os.tmpdir(), 'vibedating-media-e2e-'));
    dirs.push(d);
    return d;
  }

  /** spawn + onLink: a discovery node that also captures each live PeerLink. */
  async function spawnWithLink(
    hello: PeerHello,
    topic: Buffer,
    onLink: (link: PeerLink) => void,
  ): Promise<DiscoverySession> {
    const session = await startDiscovery({
      hello,
      topic,
      bootstrap: testnet.bootstrap,
      stateDir: tmpDir(),
      onLink,
    });
    sessions.push(session);
    return session;
  }

  it('node A sends a small PNG, node B reassembles identical bytes', async () => {
    const topic = randomTopic();

    // Write a real ~1.5 KiB PNG to a temp file on A's side.
    const png = buildPng(24, 16);
    expect(png.length).toBeGreaterThan(1024);
    expect(png.length).toBeLessThan(2048);
    const pngPath = path.join(tmpDir(), 'cat.png');
    writeFileSync(pngPath, png);

    let linkA: PeerLink | undefined;
    let linkB: PeerLink | undefined;
    const received: ReceivedMedia[] = [];

    const a = await spawnWithLink(ALICE, topic, (l) => {
      linkA = l;
    });
    const b = await spawnWithLink(BOB, topic, (l) => {
      linkB = l;
      // B must register onMedia BEFORE A sends, so the receiver exists when
      // the first media-start frame arrives.
      l.onMedia((m) => {
        receivedPaths.push(m.path);
        received.push(m);
      });
    });
    await Promise.all([a.ready, b.ready]);

    expect(await waitFor(() => !!linkA && !!linkB, 40_000)).toBe(true);

    // A sends the file over its live PeerLink (chunked, backpressure-aware).
    const sent = await linkA!.sendMedia(pngPath);
    expect(sent.size).toBe(png.length);

    // B's onMedia fires with the reassembled file.
    expect(await waitFor(() => received.length === 1, 40_000)).toBe(true);

    const got = received[0]!;
    expect(got.mime).toBe('image/png');
    expect(got.name).toBe('cat.png');
    expect(got.size).toBe(png.length);
    // The multi-machine proof: bytes on disk EQUAL the original.
    expect(readFileSync(got.path)).toEqual(png);
  }, 45_000);

  it('node A sends a small VIDEO file (multi-chunk), node B reassembles identical bytes', async () => {
    const topic = randomTopic();

    // Build a structurally-valid MP4 sized ABOVE 2 * DEFAULT_CHUNK_BYTES so the
    // transfer is genuinely multi-chunk (>= 3 chunks) under the binary wire's
    // 64 KiB default — exercising seq ordering + reassembly, not a one-chunk send.
    const mp4 = buildMp4(DEFAULT_CHUNK_BYTES * 2 + 8 * 1024);
    expect(mp4.subarray(4, 8).toString('ascii')).toBe('ftyp'); // valid MP4 box header
    expect(mp4.subarray(8, 12).toString('ascii')).toBe('isom'); // major brand
    const expectedChunks = Math.ceil(mp4.length / DEFAULT_CHUNK_BYTES);
    expect(expectedChunks).toBeGreaterThanOrEqual(3); // proves multi-chunk
    const mp4Path = path.join(tmpDir(), 'clip.mp4');
    writeFileSync(mp4Path, mp4);

    let linkA: PeerLink | undefined;
    let linkB: PeerLink | undefined;
    const received: ReceivedMedia[] = [];

    const a = await spawnWithLink(ALICE, topic, (l) => {
      linkA = l;
    });
    const b = await spawnWithLink(BOB, topic, (l) => {
      linkB = l;
      // B must register onMedia BEFORE A sends, so the receiver exists when
      // the first media-start frame arrives.
      l.onMedia((m) => {
        receivedPaths.push(m.path);
        received.push(m);
      });
    });
    await Promise.all([a.ready, b.ready]);

    expect(await waitFor(() => !!linkA && !!linkB, 40_000)).toBe(true);

    // A sends the video file over its live PeerLink (chunked, backpressure-aware).
    const sent = await linkA!.sendMedia(mp4Path);
    expect(sent.size).toBe(mp4.length);

    // B's onMedia fires with the reassembled file.
    expect(await waitFor(() => received.length === 1, 40_000)).toBe(true);

    const got = received[0]!;
    expect(got.mime).toBe('video/mp4'); // inferred from the .mp4 extension
    expect(got.name).toBe('clip.mp4');
    expect(got.size).toBe(mp4.length);
    // The multi-machine proof for VIDEO/large-file sending: bytes on disk EQUAL
    // the original, despite spanning multiple ordered chunks.
    expect(readFileSync(got.path)).toEqual(mp4);
  }, 45_000);
});
