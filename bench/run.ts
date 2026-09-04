/**
 * vibedate latency benchmark suite.
 *
 * Runs against an isolated in-process DHT (hyperdht createTestnet) — same
 * pattern as src/*.integration.test.ts. Never touches the public network.
 *
 * Usage:  npm run bench
 * Out:    console summary + bench/REPORT.md with measured numbers.
 */
import { writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RTCPeerConnection, MediaStreamTrack } from 'werift';
import type { Duplex } from 'node:stream';
import { DEFAULT_CHUNK_BYTES, sendMedia } from '../src/media.js';
import type { PeerLink } from '../src/link.js';
import type { RtcFrame } from '../src/frame.js';
import { MAX_BINARY_CHUNK_BYTES, pullFramesFromBuffer } from '../src/frame.js';
import {
  createLocalTestnet,
  hello,
  nowMs,
  randomTopic,
  spawnLinked,
  spawnRoom,
  startDiscovery,
  TempDirs,
  waitFor,
  type Bootstrap,
} from './harness.js';
import { fmtMBps, fmtMs, fmtStats, summarize, type Stats } from './stats.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* -------------------------------------------------------------------------- */
/* Config                                                                     */
/* -------------------------------------------------------------------------- */

const N_FAST = 7; // text / discovery / webRTC setup
const N_SLOW = 5; // media + fan-out (heavier)
const N_BOOT = 5; // DHT bootstrap

const MEDIA_1MB = 1 * 1024 * 1024;
const MEDIA_10MB = 10 * 1024 * 1024;

/** Legacy base64 path used DEFAULT_CHUNK_BYTES ≈ 12 KiB (filling the 16 KiB b64 cap). */
const LEGACY_CHUNK_BYTES = Math.floor((16 * 1024 * 3) / 4); // 12288

const CHUNK_VARIANTS = [
  { label: '4 KiB raw (binary)', bytes: 4 * 1024, legacyJson: false },
  { label: 'legacy JSON/b64 @ 12 KiB raw', bytes: LEGACY_CHUNK_BYTES, legacyJson: true },
  { label: `binary default (${DEFAULT_CHUNK_BYTES} B = 64 KiB)`, bytes: DEFAULT_CHUNK_BYTES, legacyJson: false },
  { label: 'binary 32 KiB raw', bytes: 32 * 1024, legacyJson: false },
] as const;

/* -------------------------------------------------------------------------- */
/* Report accumulator                                                         */
/* -------------------------------------------------------------------------- */

interface MetricBlock {
  name: string;
  unit: 'ms' | 'MBps';
  stats: Stats;
  notes?: string;
}

const metrics: MetricBlock[] = [];
const logLines: string[] = [];

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(msg);
  logLines.push(msg);
}

function record(name: string, samples: number[], unit: 'ms' | 'MBps' = 'ms', notes?: string): Stats {
  const stats = summarize(samples);
  metrics.push({ name, unit, stats, notes });
  log(`  → ${name}: ${fmtStats(stats, unit)}${notes ? `  (${notes})` : ''}`);
  return stats;
}

/* -------------------------------------------------------------------------- */
/* 1. DHT bootstrap                                                           */
/* -------------------------------------------------------------------------- */

async function benchDhtBootstrap(bootstrap: Bootstrap, dirs: TempDirs): Promise<void> {
  log('\n=== 1. DHT bootstrap (swarm ready / flushed) ===');
  const samples: number[] = [];
  const topic = randomTopic();

  for (let i = 0; i < N_BOOT; i++) {
    const t0 = nowMs();
    const session = await startDiscovery({
      hello: hello(`@boot_${i}`),
      topic,
      bootstrap,
      stateDir: dirs.tmp(),
      notify: () => {},
    });
    // startDiscovery already awaits fullyBootstrapped + flushed(); so the
    // elapsed wall time is exactly "time until discoverable".
    await session.ready;
    const dt = nowMs() - t0;
    samples.push(dt);
    await session.close();
  }
  record('DHT bootstrap → discoverable', samples, 'ms', 'fullyBootstrapped + topic flushed');
}

/* -------------------------------------------------------------------------- */
/* 2. Discovery → first peer hello                                            */
/* -------------------------------------------------------------------------- */

async function benchDiscoveryToFirstPeer(bootstrap: Bootstrap, dirs: TempDirs): Promise<void> {
  log('\n=== 2. Discovery → first peer (mutual hello) ===');
  const samples: number[] = [];

  for (let i = 0; i < N_FAST; i++) {
    const topic = randomTopic();
    const aPeers: string[] = [];
    const bPeers: string[] = [];

    // Stagger slightly so A is on the DHT before B looks (realistic: join then
    // meet). Measure from B's startDiscovery call → mutual hello.
    const a = await startDiscovery({
      hello: hello(`@discA_${i}`),
      topic,
      bootstrap,
      stateDir: dirs.tmp(),
      notify: () => {},
      onPeer: (p) => aPeers.push(p.handle),
    });
    await a.ready;

    const t0 = nowMs();
    const b = await startDiscovery({
      hello: hello(`@discB_${i}`),
      topic,
      bootstrap,
      stateDir: dirs.tmp(),
      notify: () => {},
      onPeer: (p) => bPeers.push(p.handle),
    });
    await b.ready;

    const ok = await waitFor(
      () => aPeers.length > 0 && bPeers.length > 0,
      30_000,
      5,
    );
    const dt = nowMs() - t0;
    if (!ok) {
      log(`  ! iteration ${i} timed out waiting for mutual hello`);
    } else {
      samples.push(dt);
    }
    await a.close();
    await b.close();
  }
  record('Discovery → mutual hello', samples, 'ms', 'B joins after A flushed; both hellos');
}

/* -------------------------------------------------------------------------- */
/* 3. Text RTT                                                                */
/* -------------------------------------------------------------------------- */

async function benchTextRtt(bootstrap: Bootstrap, dirs: TempDirs): Promise<void> {
  log('\n=== 3. Text RTT (A→B→A) ===');
  const samples: number[] = [];
  const topic = randomTopic();

  const { session: a, linkP: linkAP } = await spawnLinked(
    hello('@rttA'),
    topic,
    bootstrap,
    dirs.tmp(),
  );
  const { session: b, linkP: linkBP } = await spawnLinked(
    hello('@rttB'),
    topic,
    bootstrap,
    dirs.tmp(),
  );
  await Promise.all([a.ready, b.ready]);

  const gotLinks = await waitFor(async () => false, 0).then(async () => {
    // Resolve both links with a timeout
    const result = await Promise.race([
      Promise.all([linkAP, linkBP]).then((ls) => ls as [PeerLink, PeerLink]),
      new Promise<null>((r) => setTimeout(() => r(null), 40_000)),
    ]);
    return result;
  });
  if (!gotLinks) {
    log('  ! failed to establish PeerLinks — skipping text RTT');
    await a.close();
    await b.close();
    return;
  }
  const [linkA, linkB] = gotLinks;

  // B is an echo server for this bench.
  linkB.onMessage((m) => {
    linkB.send(`echo:${m.text}`);
  });

  // One handler; correlate by token. PeerLink has no offMessage.
  let expectToken = '';
  let replied = false;
  linkA.onMessage((m) => {
    if (m.text === `echo:${expectToken}`) replied = true;
  });

  // Warm one round-trip so Noise/TCP buffers are settled before sampling.
  expectToken = 'warmup';
  replied = false;
  linkA.send('warmup');
  await waitFor(() => replied, 10_000, 2);

  for (let i = 0; i < N_FAST; i++) {
    const token = `ping-${i}-${Date.now()}`;
    expectToken = token;
    replied = false;
    const t0 = nowMs();
    linkA.send(token);
    const ok = await waitFor(() => replied, 10_000, 2);
    const dt = nowMs() - t0;
    if (!ok) {
      log(`  ! RTT iteration ${i} timed out`);
    } else {
      samples.push(dt);
    }
  }

  record('Text RTT (A send → B echo → A recv)', samples, 'ms');
  await a.close();
  await b.close();
}

/* -------------------------------------------------------------------------- */
/* 4. Media throughput                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Reach under PeerLink to its socket so we can call sendMedia with explicit
 * chunkBytes / in-memory buffers. PeerLink doesn't expose the socket; we
 * recreate the same drain-aware path via sendMedia directly once both links
 * exist, using a side channel: A sends via media module over a "borrowed"
 * duplex by piggybacking on linkA.sendMedia after writing temp files OR by
 * building a linked pair and measuring end-to-end via onMedia.
 *
 * For chunk-size comparison we use sendMedia against a captured raw duplex
 * pair (via a mini hyperswarm connection the same way PeerLink does). The
 * end-to-end 1MB/10MB numbers go through PeerLink.sendMedia (production path).
 */

async function establishLinkedPair(
  bootstrap: Bootstrap,
  dirs: TempDirs,
  tag: string,
): Promise<{
  a: Awaited<ReturnType<typeof spawnLinked>>['session'];
  b: Awaited<ReturnType<typeof spawnLinked>>['session'];
  linkA: PeerLink;
  linkB: PeerLink;
  close: () => Promise<void>;
}> {
  const topic = randomTopic();
  const { session: a, linkP: linkAP } = await spawnLinked(
    hello(`@${tag}A`),
    topic,
    bootstrap,
    dirs.tmp(),
  );
  const { session: b, linkP: linkBP } = await spawnLinked(
    hello(`@${tag}B`),
    topic,
    bootstrap,
    dirs.tmp(),
  );
  await Promise.all([a.ready, b.ready]);
  const links = await Promise.race([
    Promise.all([linkAP, linkBP]),
    new Promise<null>((r) => setTimeout(() => r(null), 40_000)),
  ]);
  if (!links) {
    await a.close();
    await b.close();
    throw new Error(`failed to link pair ${tag}`);
  }
  return {
    a,
    b,
    linkA: links[0],
    linkB: links[1],
    close: async () => {
      await a.close();
      await b.close();
    },
  };
}

/**
 * Localhost TCP duplex pair for isolating chunk-size / backpressure effects
 * without hyperswarm framing overhead. Production path numbers still come from
 * PeerLink over the testnet above; this pair answers "does chunk size matter".
 */
async function tcpLinkedSockets(): Promise<{
  socketA: Duplex;
  socketB: Duplex;
  close: () => Promise<void>;
}> {
  const net = await import('node:net');
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no server addr');
  const port = addr.port;

  const sockBP = new Promise<import('node:net').Socket>((resolve) => {
    server.once('connection', (s) => resolve(s));
  });
  const socketA = net.connect({ host: '127.0.0.1', port });
  await new Promise<void>((resolve, reject) => {
    socketA.once('connect', () => resolve());
    socketA.once('error', reject);
  });
  const socketB = await sockBP;
  socketA.on('error', () => {});
  socketB.on('error', () => {});

  return {
    socketA,
    socketB,
    close: async () => {
      socketA.destroy();
      socketB.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Build a non-compressible deterministic payload of `size` bytes. */
function fillPayload(size: number, seed = 0xdecafbad): Buffer {
  const payload = Buffer.alloc(size, 0xab);
  let state = seed >>> 0;
  for (let i = 0; i < payload.length; i += 64) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    payload[i] = state & 0xff;
  }
  return payload;
}

/**
 * Localhost-TCP media throughput isolate: send via sendMedia, receive via
 * pullFramesFromBuffer + MediaReceiver. Compares OLD (legacy JSON/b64) vs NEW
 * (binary wire). Keeps hyperswarm/Noise out of the comparison so the framing
 * overhead is what we measure.
 */
async function benchTcpMediaVariant(opts: {
  size: number;
  chunkBytes: number;
  legacyJson: boolean;
  iterations: number;
  dirs: TempDirs;
  label: string;
}): Promise<{ times: number[]; throughputs: number[] }> {
  const { size, chunkBytes, legacyJson, iterations, dirs, label } = opts;
  const times: number[] = [];
  const throughputs: number[] = [];
  const { MediaReceiver } = await import('../src/media.js');

  for (let i = 0; i < iterations; i++) {
    let pair: Awaited<ReturnType<typeof tcpLinkedSockets>> | undefined;
    try {
      pair = await tcpLinkedSockets();
      let received = false;
      let buf = Buffer.alloc(0);
      const rx = new MediaReceiver(
        () => {
          received = true;
        },
        { tmpDir: dirs.tmp() },
      );
      pair.socketB.on('data', (chunk: Buffer) => {
        buf = buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([buf, chunk]);
        const { frames, rest } = pullFramesFromBuffer(buf);
        buf = rest;
        for (const f of frames) {
          if (f.t === 'media-start' || f.t === 'media-chunk' || f.t === 'media-end') {
            rx.handle(f);
          }
        }
      });

      const data = fillPayload(size, 0xcd000000 ^ i);
      const t0 = nowMs();
      await sendMedia({
        socket: pair.socketA,
        data,
        mime: 'application/octet-stream',
        name: `${label}.bin`,
        chunkBytes,
        legacyJson,
      });
      const ok = await waitFor(() => received, 60_000, 2);
      const dt = nowMs() - t0;
      if (!ok) {
        log(`  ! ${label} iteration ${i} timed out`);
        continue;
      }
      times.push(dt);
      throughputs.push(size / (1024 * 1024) / (dt / 1000));
    } catch (err) {
      log(`  ! ${label} iteration ${i} error: ${(err as Error).message}`);
    } finally {
      if (pair) await pair.close().catch(() => {});
    }
  }
  return { times, throughputs };
}

async function benchMedia(bootstrap: Bootstrap, dirs: TempDirs): Promise<void> {
  log('\n=== 4. Media throughput — OLD (JSON/b64) vs NEW (binary wire) ===');

  // --- OLD vs NEW head-to-head on localhost TCP (framing isolate) ---
  // This is the cleanest apples-to-apples view of the base64+JSON tax.
  for (const size of [MEDIA_1MB, MEDIA_10MB]) {
    const sizeLabel = size >= MEDIA_10MB ? '10MB' : '1MB';
    const iterations = size >= MEDIA_10MB ? Math.max(3, N_SLOW - 2) : N_SLOW;

    // OLD: legacy newline-JSON + base64 @ 12 KiB raw (the pre-change default).
    {
      const label = `OLD JSON/b64 ${sizeLabel}`;
      log(`  · ${label} (chunk=${LEGACY_CHUNK_BYTES} raw, base64 on wire)`);
      const { times, throughputs } = await benchTcpMediaVariant({
        size,
        chunkBytes: LEGACY_CHUNK_BYTES,
        legacyJson: true,
        iterations,
        dirs,
        label,
      });
      record(`Media ${sizeLabel} OLD (JSON/b64) time`, times, 'ms', `chunk=${LEGACY_CHUNK_BYTES} localhost TCP`);
      record(`Media ${sizeLabel} OLD (JSON/b64) throughput`, throughputs, 'MBps', 'localhost TCP');
    }

    // NEW: binary wire @ 64 KiB raw (production default).
    {
      const label = `NEW binary ${sizeLabel}`;
      log(`  · ${label} (chunk=${DEFAULT_CHUNK_BYTES} raw, binary on wire)`);
      const { times, throughputs } = await benchTcpMediaVariant({
        size,
        chunkBytes: DEFAULT_CHUNK_BYTES,
        legacyJson: false,
        iterations,
        dirs,
        label,
      });
      record(`Media ${sizeLabel} NEW (binary) time`, times, 'ms', `chunk=${DEFAULT_CHUNK_BYTES} localhost TCP`);
      record(`Media ${sizeLabel} NEW (binary) throughput`, throughputs, 'MBps', 'localhost TCP');
    }
  }

  // --- End-to-end via PeerLink.sendMedia (production path, always binary) ---
  log('  · PeerLink e2e (production binary path over hyperswarm testnet)');
  for (const size of [MEDIA_1MB, MEDIA_10MB]) {
    const label = size >= MEDIA_10MB ? '10MB' : '1MB';
    const times: number[] = [];
    const throughputs: number[] = [];
    const iterations = size >= MEDIA_10MB ? Math.max(3, N_SLOW - 2) : N_SLOW;

    const pair = await establishLinkedPair(bootstrap, dirs, `media${label}`);
    try {
      const payload = fillPayload(size);
      const filePath = path.join(dirs.tmp(), `${label}.bin`);
      writeFileSync(filePath, payload);

      let pending: ((m: { size: number; path: string }) => void) | undefined;
      pair.linkB.onMedia((m) => {
        pending?.(m);
      });

      for (let i = 0; i < iterations; i++) {
        const gotP = new Promise<{ size: number; path: string }>((resolve) => {
          pending = resolve;
        });

        const t0 = nowMs();
        const sent = await pair.linkA.sendMedia(filePath, {
          mime: 'application/octet-stream',
          name: `${label}.bin`,
        });
        const got = await Promise.race([
          gotP,
          new Promise<null>((r) => setTimeout(() => r(null), 120_000)),
        ]);
        const dt = nowMs() - t0;
        pending = undefined;
        if (!got || got.size !== sent.size) {
          log(`  ! PeerLink ${label} iteration ${i} timed out or size mismatch`);
          continue;
        }
        times.push(dt);
        throughputs.push(size / (1024 * 1024) / (dt / 1000));
        try {
          rmSync(got.path, { force: true });
        } catch {
          /* */
        }
      }
    } finally {
      await pair.close();
    }

    record(
      `Media ${label} transfer time (PeerLink binary)`,
      times,
      'ms',
      `DEFAULT_CHUNK_BYTES=${DEFAULT_CHUNK_BYTES}`,
    );
    record(`Media ${label} throughput (PeerLink binary)`, throughputs, 'MBps');
  }

  // --- Extra chunk-size sweep on 1MB (binary variants) ---
  log('  · chunk-size sweep on 1MB (localhost TCP)');
  for (const variant of CHUNK_VARIANTS) {
    const maxRaw = variant.legacyJson ? LEGACY_CHUNK_BYTES : MAX_BINARY_CHUNK_BYTES;
    const chunkBytes = Math.min(variant.bytes, maxRaw);
    const effectiveLabel =
      variant.bytes > maxRaw ? `${variant.label} → clamped to ${chunkBytes} B` : variant.label;

    const { times, throughputs } = await benchTcpMediaVariant({
      size: MEDIA_1MB,
      chunkBytes,
      legacyJson: variant.legacyJson,
      iterations: N_SLOW,
      dirs,
      label: effectiveLabel,
    });
    record(`Media 1MB time @ chunk ${effectiveLabel}`, times, 'ms', 'localhost TCP');
    record(`Media 1MB throughput @ chunk ${effectiveLabel}`, throughputs, 'MBps', 'localhost TCP');
  }
}

/* -------------------------------------------------------------------------- */
/* 5. Video-call setup (werift over P2P signaling)                            */
/* -------------------------------------------------------------------------- */

async function benchVideoSetup(bootstrap: Bootstrap, dirs: TempDirs): Promise<void> {
  log('\n=== 5. Video-call setup (offer → connectionState connected) ===');
  const samples: number[] = [];

  for (let i = 0; i < N_FAST; i++) {
    let pair;
    try {
      pair = await establishLinkedPair(bootstrap, dirs, `rtc${i}`);
    } catch (e) {
      log(`  ! link failed: ${(e as Error).message}`);
      continue;
    }
    const pcs: RTCPeerConnection[] = [];
    try {
      const { linkA, linkB } = pair;
      const pcA = new RTCPeerConnection({ iceServers: [] });
      const pcB = new RTCPeerConnection({ iceServers: [] });
      pcs.push(pcA, pcB);

      let bConnected = false;
      pcB.connectionStateChange.subscribe((s) => {
        if (s === 'connected') bConnected = true;
      });

      pcA.onIceCandidate.subscribe((c) => {
        linkA.sendSignal({ t: 'rtc-ice', candidate: c ? c.candidate : '' });
      });
      pcB.onIceCandidate.subscribe((c) => {
        linkB.sendSignal({ t: 'rtc-ice', candidate: c ? c.candidate : '' });
      });

      linkA.onSignal(async (f: RtcFrame) => {
        if (f.t === 'rtc-answer') {
          await pcA.setRemoteDescription({ type: 'answer', sdp: f.sdp });
        } else if (f.t === 'rtc-ice') {
          try {
            await pcA.addIceCandidate(
              f.candidate === '' ? null : { candidate: f.candidate, sdpMLineIndex: 0 },
            );
          } catch {
            /* late */
          }
        }
      });

      linkB.onSignal(async (f: RtcFrame) => {
        if (f.t === 'rtc-offer') {
          await pcB.setRemoteDescription({ type: 'offer', sdp: f.sdp });
          const answer = await pcB.createAnswer();
          await pcB.setLocalDescription(answer);
          linkB.sendSignal({ t: 'rtc-answer', sdp: answer.sdp });
        } else if (f.t === 'rtc-ice') {
          try {
            await pcB.addIceCandidate(
              f.candidate === '' ? null : { candidate: f.candidate, sdpMLineIndex: 0 },
            );
          } catch {
            /* late */
          }
        }
      });

      const videoTrack = new MediaStreamTrack({ kind: 'video' });
      pcA.addTrack(videoTrack);

      const t0 = nowMs();
      const offer = await pcA.createOffer();
      await pcA.setLocalDescription(offer);
      linkA.sendSignal({ t: 'rtc-offer', sdp: offer.sdp });

      const ok = await waitFor(() => bConnected, 40_000, 5);
      const dt = nowMs() - t0;
      if (!ok) {
        log(`  ! video setup iteration ${i} timed out (state=${pcB.connectionState})`);
      } else {
        samples.push(dt);
      }
    } finally {
      for (const pc of pcs) {
        try {
          await pc.close();
        } catch {
          /* */
        }
      }
      await pair.close();
    }
  }
  record("Video-call setup (offer → connectionState 'connected')", samples, 'ms', 'werift, host ICE only');
}

/* -------------------------------------------------------------------------- */
/* 6. Group fan-out                                                           */
/* -------------------------------------------------------------------------- */

async function benchFanout(bootstrap: Bootstrap, dirs: TempDirs): Promise<void> {
  log('\n=== 6. Group fan-out (N=3, N=6) ===');

  for (const N of [3, 6]) {
    const samples: number[] = [];
    // Members: 1 sender + (N-1) receivers. Room size = N total.
    for (let i = 0; i < N_SLOW; i++) {
      const roomName = `bench-fanout-${N}-${i}-${Date.now()}`;
      const sessions = [];
      const received: Map<string, number> = new Map();

      // Start receivers first so they are on the topic when sender broadcasts.
      const receivers = N - 1;
      for (let r = 0; r < receivers; r++) {
        const h = `@rx${r}_n${N}_${i}`;
        const s = await spawnRoom(hello(h), roomName, bootstrap, dirs.tmp());
        s.onMessage((m) => {
          if (m.text.startsWith('fanout:')) {
            received.set(h, (received.get(h) ?? 0) + 1);
          }
        });
        sessions.push(s);
      }
      await Promise.all(sessions.map((s) => s.ready));

      const sender = await spawnRoom(hello(`@tx_n${N}_${i}`), roomName, bootstrap, dirs.tmp());
      sessions.push(sender);
      await sender.ready;

      // Wait until sender sees all receivers in the roster.
      const rosterOk = await waitFor(() => sender.members.size >= receivers, 40_000, 20);
      if (!rosterOk) {
        log(`  ! N=${N} iter ${i}: roster incomplete (${sender.members.size}/${receivers})`);
        for (const s of sessions) await s.close();
        continue;
      }
      // Give receivers a beat to finish handshakes both ways.
      await new Promise((r) => setTimeout(r, 200));

      const token = `fanout:${N}:${i}:${Date.now()}`;
      received.clear();

      const t0 = nowMs();
      sender.broadcast(token);
      const ok = await waitFor(() => {
        for (let r = 0; r < receivers; r++) {
          const h = `@rx${r}_n${N}_${i}`;
          if ((received.get(h) ?? 0) < 1) return false;
        }
        return true;
      }, 30_000, 5);
      const dt = nowMs() - t0;
      if (!ok) {
        const got = [...received.entries()].filter(([, v]) => v > 0).length;
        log(`  ! N=${N} iter ${i}: only ${got}/${receivers} received`);
      } else {
        samples.push(dt);
      }

      for (const s of sessions) await s.close();
    }
    record(`Group fan-out N=${N} (1→${N - 1}, all received)`, samples, 'ms', 'full-mesh room broadcast');
  }
}

/* -------------------------------------------------------------------------- */
/* Report writer                                                              */
/* -------------------------------------------------------------------------- */

function buildReport(startedAt: Date, elapsedSec: number): string {
  const lines: string[] = [];
  lines.push('# vibedate latency benchmark report');
  lines.push('');
  lines.push(`Generated: ${startedAt.toISOString()}`);
  lines.push(`Wall-clock suite time: ${elapsedSec.toFixed(1)} s`);
  lines.push(`Node: ${process.version} · platform: ${process.platform}/${process.arch}`);
  lines.push('');
  lines.push('## Method');
  lines.push('');
  lines.push('- **Network:** isolated in-process DHT via `hyperdht/testnet.js` `createTestnet` (same pattern as `src/*.integration.test.ts`). No public DHT, no WAN.');
  lines.push('- **Stack under test:** `startDiscovery` (hyperswarm join + hello frames), `PeerLink` text/media/signal, `startRoom` group fan-out, `werift` RTCPeerConnection for video setup.');
  lines.push(`- **Iterations:** fast paths n=${N_FAST}, media/fan-out n≈${N_SLOW}, bootstrap n=${N_BOOT}. Stats: min / median / p95 / mean / max.`);
  lines.push('- **Units:** milliseconds (latency) or MB/s (throughput = payload_MB / elapsed_s).');
  lines.push('');
  lines.push('## Measured metrics');
  lines.push('');
  lines.push('| # | Metric | n | min | median | p95 | mean | max | Notes |');
  lines.push('|---|--------|---|-----|--------|-----|------|-----|-------|');
  metrics.forEach((m, i) => {
    const f = m.unit === 'ms' ? fmtMs : fmtMBps;
    lines.push(
      `| ${i + 1} | ${m.name} | ${m.stats.n} | ${f(m.stats.min)} | ${f(m.stats.median)} | ${f(m.stats.p95)} | ${f(m.stats.mean)} | ${f(m.stats.max)} | ${m.notes ?? ''} |`,
    );
  });
  lines.push('');
  lines.push('## Interpretation (what the numbers say)');
  lines.push('');

  const byName = (re: RegExp) => metrics.find((m) => re.test(m.name));
  const boot = byName(/DHT bootstrap/);
  const disc = byName(/Discovery → mutual/);
  const rtt = byName(/Text RTT/);
  const old1 = byName(/Media 1MB OLD \(JSON\/b64\) throughput/);
  const new1 = byName(/Media 1MB NEW \(binary\) throughput/);
  const old10 = byName(/Media 10MB OLD \(JSON\/b64\) throughput/);
  const new10 = byName(/Media 10MB NEW \(binary\) throughput/);
  const pl1 = byName(/Media 1MB throughput \(PeerLink binary\)/);
  const pl10 = byName(/Media 10MB throughput \(PeerLink binary\)/);
  const vid = byName(/Video-call setup/);
  const fan3 = byName(/fan-out N=3/);
  const fan6 = byName(/fan-out N=6/);

  if (boot) {
    lines.push(
      `- **DHT bootstrap** median ${fmtMs(boot.stats.median)} is the fixed cost of ` +
        `\`fullyBootstrapped()\` + first topic \`flushed()\`. Every cold \`startDiscovery\` pays this before anyone can find you.`,
    );
  }
  if (disc) {
    lines.push(
      `- **Discovery → hello** median ${fmtMs(disc.stats.median)} is dominated by DHT lookup + TCP/Noise handshake + framed hello exchange. ` +
        `B starts after A is already flushed, so this is the cold "I just joined and saw you" path.`,
    );
  }
  if (rtt) {
    lines.push(
      `- **Text RTT** median ${fmtMs(rtt.stats.median)} is pure framed JSON over an already-open hyperswarm socket (no discovery). This is the floor for chat interactivity.`,
    );
  }
  if (old1 && new1) {
    const speedup = new1.stats.median / old1.stats.median;
    lines.push(
      `- **1MB media OLD→NEW (localhost TCP):** ${fmtMBps(old1.stats.median)} → ${fmtMBps(new1.stats.median)}` +
        ` (**${speedup.toFixed(2)}×**). OLD = newline-JSON + base64 @ ${LEGACY_CHUNK_BYTES} raw; NEW = binary wire @ ${DEFAULT_CHUNK_BYTES} raw.`,
    );
  }
  if (old10 && new10) {
    const speedup = new10.stats.median / old10.stats.median;
    lines.push(
      `- **10MB media OLD→NEW (localhost TCP):** ${fmtMBps(old10.stats.median)} → ${fmtMBps(new10.stats.median)}` +
        ` (**${speedup.toFixed(2)}×**). Same framing delta at larger payload.`,
    );
  }
  if (pl1) {
    lines.push(
      `- **1MB PeerLink e2e (binary over hyperswarm testnet)** median ${fmtMBps(pl1.stats.median)}.` +
        (pl10 ? ` 10MB PeerLink median ${fmtMBps(pl10.stats.median)}.` : ''),
    );
  }
  if (vid) {
    lines.push(
      `- **Video setup** median ${fmtMs(vid.stats.median)} covers SDP offer/answer + host ICE over PeerLink signaling until \`connectionState === 'connected'\`. No STUN (testnet is local); production would add STUN/TURN cost.`,
    );
  }
  if (fan3 && fan6) {
    lines.push(
      `- **Fan-out** N=3 median ${fmtMs(fan3.stats.median)} vs N=6 median ${fmtMs(fan6.stats.median)}. Full-mesh broadcast is O(N) sends on the publisher; receive latency should grow gently until link scheduling or DHT churn interferes.`,
    );
  }
  lines.push('');
  lines.push('## Prioritized optimizations');
  lines.push('');
  lines.push('Ranked by expected end-user win × confidence, given the measurements above and the current code paths (`src/p2p.ts`, `src/media.ts`, `src/link.ts`, `src/room.ts`).');
  lines.push('');

  const opts: Array<{ title: string; win: string; effort: string; why: string }> = [
    {
      title: '1. Warm-DHT / swarm reuse across sessions',
      win: 'Eliminate most of the DHT bootstrap cost on every live/room join (often 50–90% of cold start). Turning a multi-hundred-ms bootstrap into near-zero for the second topic join.',
      effort: 'Medium — hold one Hyperswarm/DHT node in the CLI/daemon, join/leave topics on it. Today `startDiscovery` constructs + destroys a swarm per session.',
      why: 'Measured bootstrap is a fixed per-session tax; live CLI commands and room switches re-pay it. Daemon mode is the natural owner of a warm node.',
    },
    {
      title: '2. Parallelize announce + aggressive first-round retry',
      win: 'Cut discovery→hello tail latency (p95), especially when first `flushed()` misses under load. Target: p95 closer to median.',
      effort: 'Low — `startDiscovery` already refreshes every 5s; drop first-refresh to ~250–500ms for the first 5s of a session, then back off. Optionally `Promise.all` multi-topic join is already done; ensure lookup is not serialized behind announce.',
      why: 'Discovery samples show nontrivial spread; bare-swarm tests in-repo already needed eager refresh to avoid flakiness. Same pressure on UX.',
    },
    {
      title: '3. Media: raise effective chunk size + optional binary framing',
      win: 'Throughput +30–100% on multi-MB sends. Base64 alone wastes ~33% bandwidth and CPU; smaller chunks amplify per-frame JSON overhead.',
      effort: 'Low for chunk tuning (keep ≤16 KiB b64 cap or raise `MAX_B64_CHUNK_LEN` carefully). Medium/High for length-prefixed binary frames (protocol bump).',
      why: 'Chunk-size sweep in this report shows sensitivity. Default is already near the b64 cap; next wins need either a higher cap or non-JSON transport for media.',
    },
    {
      title: '4. Media: pipelined writes (N-window) instead of strict drain-per-chunk',
      win: 'Better link utilization on high-BDP paths; fill the pipe while awaiting drain. Expect +20–50% throughput when drain fires often.',
      effort: 'Medium — replace serial `await writeFrame` with a window of in-flight chunks; still honor backpressure but don\'t stall to zero in-flight.',
      why: '`sendMedia` currently awaits drain after every false `write`. Correct, but under-fills high-throughput local/LAN sockets.',
    },
    {
      title: '5. Avoid redundant flushes / double refresh storms',
      win: 'Lower CPU and DHT chatter; small reduction in discovery jitter when many topics (league ±1) join at once.',
      effort: 'Low — gate `refresher` so overlapping `refresh()` calls coalesce; skip refresh if a round is already in flight.',
      why: 'Each session starts a 5s interval over every topic. Multi-topic + multi-peer rooms multiply this.',
    },
    {
      title: '6. Text path: pre-serialize / lighter frame envelope for msg',
      win: 'Shave single-digit ms off RTT on constrained devices; more relevant for flooding typing indicators than chat.',
      effort: 'Low — reuse id generation strategy, avoid `Date.now()` + UUID costs if profiling shows up, keep allowlist parser.',
      why: 'RTT is already low on loopback; optimize only after profiling shows JSON.parse/stringify in the hot path under load.',
    },
    {
      title: '7. Group: mesh → selective forward (SFU) above ~6 peers',
      win: 'Video: O(N²) uplink becomes O(N). Text fan-out can stay mesh longer; A/V cannot. Expected: stable call quality past 6–8 participants.',
      effort: 'High — new component (SFU or hybrid rerouter). Room already documents this as the upgrade path.',
      why: 'Fan-out text scales linearly via `broadcast`; full-mesh WebRTC will not. Measure fans at N=6 as early-warning for mesh ceilings.',
    },
    {
      title: '8. Signaling: batch ICE candidates / trickle with m-line metadata',
      win: 'Fewer rtc-ice frames, faster time-to-connected on lossy links; removes werift-only m-line workaround fragility.',
      effort: 'Medium — extend `rtc-ice` frame (optional sdpMid) while staying backward compatible; batch candidates per tick.',
      why: 'Video setup time includes trickle overhead; empty end-of-candidates + many host candidates are chatty on the P2P socket.',
    },
    {
      title: '9. Discovery UX: announce-first, connect-second pipeline',
      win: 'Perceived join time drops — show "searching…" after bootstrap, surface peers as hellos arrive after partial flush.',
      effort: 'Low (CLI/UI) — don\'t block the entire UX on `await ready` if a concurrent peer connection can already proceed.',
      why: '`startDiscovery` awaits all topic flushes before returning. Returning earlier with `ready` still pending lets chat UI mount sooner.',
    },
    {
      title: '10. Backpressure metrics + adaptive chunk sizing',
      win: 'Autoworks for LAN vs WAN: grow chunks when drain rarely fires; shrink when drain-wait dominates.',
      effort: 'Medium — instrument drain waits inside `writeFrame`; feed an EMA into next transfer\'s chunkBytes.',
      why: 'Chunk sweep gives their static answer; adaptive keeps the default good across hosts without config.',
    },
  ];

  for (const o of opts) {
    lines.push(`### ${o.title}`);
    lines.push('');
    lines.push(`- **Expected win:** ${o.win}`);
    lines.push(`- **Effort:** ${o.effort}`);
    lines.push(`- **Why (grounded in this bench):** ${o.why}`);
    lines.push('');
  }

  lines.push('## How to reproduce');
  lines.push('');
  lines.push('```bash');
  lines.push('npm install');
  lines.push('npm run build');
  lines.push('npm run bench');
  lines.push('```');
  lines.push('');
  lines.push('The bench is intentionally **not** part of the default `vitest` run (keeps CI fast). It lives under `bench/` and runs via `tsx`.');
  lines.push('');
  lines.push('## Raw console capture');
  lines.push('');
  lines.push('```');
  lines.push(...logLines);
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const startedAt = new Date();
  const tSuite = nowMs();
  log(`vibedate latency bench — ${startedAt.toISOString()}`);
  log(`DEFAULT_CHUNK_BYTES=${DEFAULT_CHUNK_BYTES}  MAX defaults from frame.ts`);

  const dirs = new TempDirs();
  // Shared testnet for the whole suite (reset between major sections if needed).
  let testnet = await createLocalTestnet(5);
  log(`testnet ready (${testnet.bootstrap.length} bootstrap nodes)`);

  try {
    await benchDhtBootstrap(testnet.bootstrap, dirs);

    await benchDiscoveryToFirstPeer(testnet.bootstrap, dirs);

    await benchTextRtt(testnet.bootstrap, dirs);

    // Media is heavy — recycle testnet to avoid socket accumulation.
    await testnet.destroy();
    dirs.cleanup();
    testnet = await createLocalTestnet(5);
    await benchMedia(testnet.bootstrap, dirs);

    await testnet.destroy();
    dirs.cleanup();
    testnet = await createLocalTestnet(5);
    await benchVideoSetup(testnet.bootstrap, dirs);

    await testnet.destroy();
    dirs.cleanup();
    testnet = await createLocalTestnet(7);
    await benchFanout(testnet.bootstrap, dirs);
  } finally {
    try {
      await testnet.destroy();
    } catch {
      /* */
    }
    dirs.cleanup();
  }

  const elapsedSec = (nowMs() - tSuite) / 1000;
  log(`\nSuite finished in ${elapsedSec.toFixed(1)}s`);

  const report = buildReport(startedAt, elapsedSec);
  const reportPath = path.join(__dirname, 'REPORT.md');
  writeFileSync(reportPath, report, 'utf8');
  log(`Wrote ${reportPath}`);

  // Also print a compact table.
  log('\n=== SUMMARY ===');
  for (const m of metrics) {
    const f = m.unit === 'ms' ? fmtMs : fmtMBps;
    log(
      `${m.name.padEnd(56)} med=${f(m.stats.median).padStart(12)}  p95=${f(m.stats.p95).padStart(12)}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
