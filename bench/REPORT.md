# vibedate latency benchmark report

Generated: 2026-07-29T02:07:57.061Z
Wall-clock suite time: 5.6 s
Node: v25.9.0 · platform: darwin/arm64

## Binary wire — OLD vs NEW (headline)

Media chunk payloads no longer ride newline-JSON + base64. Control frames
(`media-start` / `media-end` / `msg` / `hello` / `rtc-*`) stay newline-JSON;
chunks use a length-prefixed binary frame on the **same** PeerLink socket.

| Path | 1MB median | 10MB median | Notes |
|------|------------|-------------|-------|
| **OLD** JSON + base64 @ 12 KiB raw (localhost TCP) | **199.86 MB/s** | **308.62 MB/s** | pre-change framing |
| **NEW** binary @ 64 KiB raw (localhost TCP) | **283.45 MB/s** | **443.16 MB/s** | ~1.4× on pure framing isolate |
| **NEW** PeerLink e2e (hyperswarm testnet) | **71.97 MB/s** | **70.38 MB/s** | production path (was ~49 / ~55 MB/s on prior JSON PeerLink report) |

Prior baseline (bench/REPORT.md before this change, PeerLink JSON/b64):
**Media 1MB ~48.71 MB/s · Media 10MB ~55.15 MB/s**. After binary wire:
**PeerLink 1MB ~72 MB/s · 10MB ~70 MB/s** (~1.5× end-to-end). Framing isolate
(JSON vs binary on plain TCP) shows the pure tax: **~200 → ~283 MB/s (1MB)**,
**~309 → ~443 MB/s (10MB)**.

### Framing design

```
JSON control:  {…}\n                                 (starts with 0x7b '{')
Binary chunk:  [0x01][hdrLen:u16BE][payloadLen:u32BE][hdr_json][raw bytes]
               hdr_json = {"id":"…","seq":N}  (allowlisted; no payload/extra keys)
```

`pullFramesFromBuffer` demuxes both on one byte stream. Tag `0x01` can never be
mistaken for JSON. Caps preserved: 25 MiB total, 64 KiB raw per binary chunk,
privacy allowlist (media metadata + bytes only).

## Method

- **Network:** isolated in-process DHT via `hyperdht/testnet.js` `createTestnet` (same pattern as `src/*.integration.test.ts`). No public DHT, no WAN.
- **Stack under test:** `startDiscovery` (hyperswarm join + hello frames), `PeerLink` text/media/signal, `startRoom` group fan-out, `werift` RTCPeerConnection for video setup.
- **Iterations:** fast paths n=7, media/fan-out n≈5, bootstrap n=5. Stats: min / median / p95 / mean / max.
- **Units:** milliseconds (latency) or MB/s (throughput = payload_MB / elapsed_s).

## Measured metrics

| # | Metric | n | min | median | p95 | mean | max | Notes |
|---|--------|---|-----|--------|-----|------|-----|-------|
| 1 | DHT bootstrap → discoverable | 5 | 1.90 ms | 2.28 ms | 8.44 ms | 3.78 ms | 9.85 ms | fullyBootstrapped + topic flushed |
| 2 | Discovery → mutual hello | 7 | 7.27 ms | 8.09 ms | 13.3 ms | 9.03 ms | 15.0 ms | B joins after A flushed; both hellos |
| 3 | Text RTT (A send → B echo → A recv) | 7 | 1.70 ms | 2.60 ms | 2.88 ms | 2.37 ms | 2.89 ms |  |
| 4 | Media 1MB OLD (JSON/b64) time | 5 | 4.49 ms | 5.00 ms | 5.16 ms | 4.93 ms | 5.19 ms | chunk=12288 localhost TCP |
| 5 | Media 1MB OLD (JSON/b64) throughput | 5 | 192.50 MB/s | 199.86 MB/s | 218.64 MB/s | 203.27 MB/s | 222.77 MB/s | localhost TCP |
| 6 | Media 1MB NEW (binary) time | 5 | 2.56 ms | 3.53 ms | 3.71 ms | 3.39 ms | 3.71 ms | chunk=65536 localhost TCP |
| 7 | Media 1MB NEW (binary) throughput | 5 | 269.35 MB/s | 283.45 MB/s | 370.32 MB/s | 300.82 MB/s | 390.69 MB/s | localhost TCP |
| 8 | Media 10MB OLD (JSON/b64) time | 3 | 31.0 ms | 32.4 ms | 35.3 ms | 33.0 ms | 35.6 ms | chunk=12288 localhost TCP |
| 9 | Media 10MB OLD (JSON/b64) throughput | 3 | 281.16 MB/s | 308.62 MB/s | 321.47 MB/s | 304.23 MB/s | 322.90 MB/s | localhost TCP |
| 10 | Media 10MB NEW (binary) time | 3 | 21.0 ms | 22.6 ms | 23.0 ms | 22.2 ms | 23.0 ms | chunk=65536 localhost TCP |
| 11 | Media 10MB NEW (binary) throughput | 3 | 434.44 MB/s | 443.16 MB/s | 473.45 MB/s | 451.47 MB/s | 476.81 MB/s | localhost TCP |
| 12 | Media 1MB transfer time (PeerLink binary) | 5 | 13.7 ms | 13.9 ms | 16.9 ms | 14.6 ms | 17.6 ms | DEFAULT_CHUNK_BYTES=65536 |
| 13 | Media 1MB throughput (PeerLink binary) | 5 | 56.77 MB/s | 71.97 MB/s | 73.05 MB/s | 69.32 MB/s | 73.07 MB/s |  |
| 14 | Media 10MB transfer time (PeerLink binary) | 3 | 140.9 ms | 142.1 ms | 142.9 ms | 142.0 ms | 143.0 ms | DEFAULT_CHUNK_BYTES=65536 |
| 15 | Media 10MB throughput (PeerLink binary) | 3 | 69.92 MB/s | 70.38 MB/s | 70.91 MB/s | 70.43 MB/s | 70.97 MB/s |  |
| 16 | Media 1MB time @ chunk 4 KiB raw (binary) | 5 | 2.36 ms | 3.64 ms | 5.54 ms | 3.82 ms | 6.01 ms | localhost TCP |
| 17 | Media 1MB throughput @ chunk 4 KiB raw (binary) | 5 | 166.38 MB/s | 274.76 MB/s | 396.76 MB/s | 286.00 MB/s | 423.24 MB/s | localhost TCP |
| 18 | Media 1MB time @ chunk legacy JSON/b64 @ 12 KiB raw | 5 | 3.30 ms | 4.56 ms | 5.66 ms | 4.59 ms | 5.73 ms | localhost TCP |
| 19 | Media 1MB throughput @ chunk legacy JSON/b64 @ 12 KiB raw | 5 | 174.55 MB/s | 219.24 MB/s | 292.83 MB/s | 226.98 MB/s | 302.69 MB/s | localhost TCP |
| 20 | Media 1MB time @ chunk binary default (65536 B = 64 KiB) | 5 | 2.32 ms | 2.42 ms | 3.13 ms | 2.60 ms | 3.23 ms | localhost TCP |
| 21 | Media 1MB throughput @ chunk binary default (65536 B = 64 KiB) | 5 | 309.68 MB/s | 413.96 MB/s | 430.60 MB/s | 390.22 MB/s | 431.31 MB/s | localhost TCP |
| 22 | Media 1MB time @ chunk binary 32 KiB raw | 5 | 2.46 ms | 2.50 ms | 3.42 ms | 2.75 ms | 3.61 ms | localhost TCP |
| 23 | Media 1MB throughput @ chunk binary 32 KiB raw | 5 | 276.98 MB/s | 400.71 MB/s | 405.55 MB/s | 372.10 MB/s | 406.17 MB/s | localhost TCP |
| 24 | Video-call setup (offer → connectionState 'connected') | 7 | 197.8 ms | 263.9 ms | 399.9 ms | 277.3 ms | 440.2 ms | werift, host ICE only |
| 25 | Group fan-out N=3 (1→2, all received) | 5 | 5.04 ms | 5.93 ms | 6.17 ms | 5.73 ms | 6.19 ms | full-mesh room broadcast |
| 26 | Group fan-out N=6 (1→5, all received) | 5 | 5.19 ms | 5.89 ms | 6.57 ms | 5.92 ms | 6.69 ms | full-mesh room broadcast |

## Interpretation (what the numbers say)

- **DHT bootstrap** median 2.28 ms is the fixed cost of `fullyBootstrapped()` + first topic `flushed()`. Every cold `startDiscovery` pays this before anyone can find you.
- **Discovery → hello** median 8.09 ms is dominated by DHT lookup + TCP/Noise handshake + framed hello exchange. B starts after A is already flushed, so this is the cold "I just joined and saw you" path.
- **Text RTT** median 2.60 ms is pure framed JSON over an already-open hyperswarm socket (no discovery). This is the floor for chat interactivity.
- **1MB media OLD→NEW (localhost TCP):** 199.86 MB/s → 283.45 MB/s (**1.42×**). OLD = newline-JSON + base64 @ 12288 raw; NEW = binary wire @ 65536 raw.
- **10MB media OLD→NEW (localhost TCP):** 308.62 MB/s → 443.16 MB/s (**1.44×**). Same framing delta at larger payload.
- **1MB PeerLink e2e (binary over hyperswarm testnet)** median 71.97 MB/s. 10MB PeerLink median 70.38 MB/s.
- **Video setup** median 263.9 ms covers SDP offer/answer + host ICE over PeerLink signaling until `connectionState === 'connected'`. No STUN (testnet is local); production would add STUN/TURN cost.
- **Fan-out** N=3 median 5.93 ms vs N=6 median 5.89 ms. Full-mesh broadcast is O(N) sends on the publisher; receive latency should grow gently until link scheduling or DHT churn interferes.

## Prioritized optimizations

Ranked by expected end-user win × confidence, given the measurements above and the current code paths (`src/p2p.ts`, `src/media.ts`, `src/link.ts`, `src/room.ts`).

### 1. Warm-DHT / swarm reuse across sessions

- **Expected win:** Eliminate most of the DHT bootstrap cost on every live/room join (often 50–90% of cold start). Turning a multi-hundred-ms bootstrap into near-zero for the second topic join.
- **Effort:** Medium — hold one Hyperswarm/DHT node in the CLI/daemon, join/leave topics on it. Today `startDiscovery` constructs + destroys a swarm per session.
- **Why (grounded in this bench):** Measured bootstrap is a fixed per-session tax; live CLI commands and room switches re-pay it. Daemon mode is the natural owner of a warm node.

### 2. Parallelize announce + aggressive first-round retry

- **Expected win:** Cut discovery→hello tail latency (p95), especially when first `flushed()` misses under load. Target: p95 closer to median.
- **Effort:** Low — `startDiscovery` already refreshes every 5s; drop first-refresh to ~250–500ms for the first 5s of a session, then back off. Optionally `Promise.all` multi-topic join is already done; ensure lookup is not serialized behind announce.
- **Why (grounded in this bench):** Discovery samples show nontrivial spread; bare-swarm tests in-repo already needed eager refresh to avoid flakiness. Same pressure on UX.

### 3. Media: raise effective chunk size + optional binary framing

- **Expected win:** Throughput +30–100% on multi-MB sends. Base64 alone wastes ~33% bandwidth and CPU; smaller chunks amplify per-frame JSON overhead.
- **Effort:** Low for chunk tuning (keep ≤16 KiB b64 cap or raise `MAX_B64_CHUNK_LEN` carefully). Medium/High for length-prefixed binary frames (protocol bump).
- **Why (grounded in this bench):** Chunk-size sweep in this report shows sensitivity. Default is already near the b64 cap; next wins need either a higher cap or non-JSON transport for media.

### 4. Media: pipelined writes (N-window) instead of strict drain-per-chunk

- **Expected win:** Better link utilization on high-BDP paths; fill the pipe while awaiting drain. Expect +20–50% throughput when drain fires often.
- **Effort:** Medium — replace serial `await writeFrame` with a window of in-flight chunks; still honor backpressure but don't stall to zero in-flight.
- **Why (grounded in this bench):** `sendMedia` currently awaits drain after every false `write`. Correct, but under-fills high-throughput local/LAN sockets.

### 5. Avoid redundant flushes / double refresh storms

- **Expected win:** Lower CPU and DHT chatter; small reduction in discovery jitter when many topics (league ±1) join at once.
- **Effort:** Low — gate `refresher` so overlapping `refresh()` calls coalesce; skip refresh if a round is already in flight.
- **Why (grounded in this bench):** Each session starts a 5s interval over every topic. Multi-topic + multi-peer rooms multiply this.

### 6. Text path: pre-serialize / lighter frame envelope for msg

- **Expected win:** Shave single-digit ms off RTT on constrained devices; more relevant for flooding typing indicators than chat.
- **Effort:** Low — reuse id generation strategy, avoid `Date.now()` + UUID costs if profiling shows up, keep allowlist parser.
- **Why (grounded in this bench):** RTT is already low on loopback; optimize only after profiling shows JSON.parse/stringify in the hot path under load.

### 7. Group: mesh → selective forward (SFU) above ~6 peers

- **Expected win:** Video: O(N²) uplink becomes O(N). Text fan-out can stay mesh longer; A/V cannot. Expected: stable call quality past 6–8 participants.
- **Effort:** High — new component (SFU or hybrid rerouter). Room already documents this as the upgrade path.
- **Why (grounded in this bench):** Fan-out text scales linearly via `broadcast`; full-mesh WebRTC will not. Measure fans at N=6 as early-warning for mesh ceilings.

### 8. Signaling: batch ICE candidates / trickle with m-line metadata

- **Expected win:** Fewer rtc-ice frames, faster time-to-connected on lossy links; removes werift-only m-line workaround fragility.
- **Effort:** Medium — extend `rtc-ice` frame (optional sdpMid) while staying backward compatible; batch candidates per tick.
- **Why (grounded in this bench):** Video setup time includes trickle overhead; empty end-of-candidates + many host candidates are chatty on the P2P socket.

### 9. Discovery UX: announce-first, connect-second pipeline

- **Expected win:** Perceived join time drops — show "searching…" after bootstrap, surface peers as hellos arrive after partial flush.
- **Effort:** Low (CLI/UI) — don't block the entire UX on `await ready` if a concurrent peer connection can already proceed.
- **Why (grounded in this bench):** `startDiscovery` awaits all topic flushes before returning. Returning earlier with `ready` still pending lets chat UI mount sooner.

### 10. Backpressure metrics + adaptive chunk sizing

- **Expected win:** Autoworks for LAN vs WAN: grow chunks when drain rarely fires; shrink when drain-wait dominates.
- **Effort:** Medium — instrument drain waits inside `writeFrame`; feed an EMA into next transfer's chunkBytes.
- **Why (grounded in this bench):** Chunk sweep gives their static answer; adaptive keeps the default good across hosts without config.

## How to reproduce

```bash
npm install
npm run build
npm run bench
```

The bench is intentionally **not** part of the default `vitest` run (keeps CI fast). It lives under `bench/` and runs via `tsx`.

## Raw console capture

```
vibedate latency bench — 2026-07-29T02:07:57.061Z
DEFAULT_CHUNK_BYTES=65536  MAX defaults from frame.ts
testnet ready (1 bootstrap nodes)

=== 1. DHT bootstrap (swarm ready / flushed) ===
  → DHT bootstrap → discoverable: n=5  min=1.90 ms  median=2.28 ms  p95=8.44 ms  mean=3.78 ms  max=9.85 ms  (fullyBootstrapped + topic flushed)

=== 2. Discovery → first peer (mutual hello) ===
  → Discovery → mutual hello: n=7  min=7.27 ms  median=8.09 ms  p95=13.3 ms  mean=9.03 ms  max=15.0 ms  (B joins after A flushed; both hellos)

=== 3. Text RTT (A→B→A) ===
  → Text RTT (A send → B echo → A recv): n=7  min=1.70 ms  median=2.60 ms  p95=2.88 ms  mean=2.37 ms  max=2.89 ms

=== 4. Media throughput — OLD (JSON/b64) vs NEW (binary wire) ===
  · OLD JSON/b64 1MB (chunk=12288 raw, base64 on wire)
  → Media 1MB OLD (JSON/b64) time: n=5  min=4.49 ms  median=5.00 ms  p95=5.16 ms  mean=4.93 ms  max=5.19 ms  (chunk=12288 localhost TCP)
  → Media 1MB OLD (JSON/b64) throughput: n=5  min=192.50 MB/s  median=199.86 MB/s  p95=218.64 MB/s  mean=203.27 MB/s  max=222.77 MB/s  (localhost TCP)
  · NEW binary 1MB (chunk=65536 raw, binary on wire)
  → Media 1MB NEW (binary) time: n=5  min=2.56 ms  median=3.53 ms  p95=3.71 ms  mean=3.39 ms  max=3.71 ms  (chunk=65536 localhost TCP)
  → Media 1MB NEW (binary) throughput: n=5  min=269.35 MB/s  median=283.45 MB/s  p95=370.32 MB/s  mean=300.82 MB/s  max=390.69 MB/s  (localhost TCP)
  · OLD JSON/b64 10MB (chunk=12288 raw, base64 on wire)
  → Media 10MB OLD (JSON/b64) time: n=3  min=31.0 ms  median=32.4 ms  p95=35.3 ms  mean=33.0 ms  max=35.6 ms  (chunk=12288 localhost TCP)
  → Media 10MB OLD (JSON/b64) throughput: n=3  min=281.16 MB/s  median=308.62 MB/s  p95=321.47 MB/s  mean=304.23 MB/s  max=322.90 MB/s  (localhost TCP)
  · NEW binary 10MB (chunk=65536 raw, binary on wire)
  → Media 10MB NEW (binary) time: n=3  min=21.0 ms  median=22.6 ms  p95=23.0 ms  mean=22.2 ms  max=23.0 ms  (chunk=65536 localhost TCP)
  → Media 10MB NEW (binary) throughput: n=3  min=434.44 MB/s  median=443.16 MB/s  p95=473.45 MB/s  mean=451.47 MB/s  max=476.81 MB/s  (localhost TCP)
  · PeerLink e2e (production binary path over hyperswarm testnet)
  → Media 1MB transfer time (PeerLink binary): n=5  min=13.7 ms  median=13.9 ms  p95=16.9 ms  mean=14.6 ms  max=17.6 ms  (DEFAULT_CHUNK_BYTES=65536)
  → Media 1MB throughput (PeerLink binary): n=5  min=56.77 MB/s  median=71.97 MB/s  p95=73.05 MB/s  mean=69.32 MB/s  max=73.07 MB/s
  → Media 10MB transfer time (PeerLink binary): n=3  min=140.9 ms  median=142.1 ms  p95=142.9 ms  mean=142.0 ms  max=143.0 ms  (DEFAULT_CHUNK_BYTES=65536)
  → Media 10MB throughput (PeerLink binary): n=3  min=69.92 MB/s  median=70.38 MB/s  p95=70.91 MB/s  mean=70.43 MB/s  max=70.97 MB/s
  · chunk-size sweep on 1MB (localhost TCP)
  → Media 1MB time @ chunk 4 KiB raw (binary): n=5  min=2.36 ms  median=3.64 ms  p95=5.54 ms  mean=3.82 ms  max=6.01 ms  (localhost TCP)
  → Media 1MB throughput @ chunk 4 KiB raw (binary): n=5  min=166.38 MB/s  median=274.76 MB/s  p95=396.76 MB/s  mean=286.00 MB/s  max=423.24 MB/s  (localhost TCP)
  → Media 1MB time @ chunk legacy JSON/b64 @ 12 KiB raw: n=5  min=3.30 ms  median=4.56 ms  p95=5.66 ms  mean=4.59 ms  max=5.73 ms  (localhost TCP)
  → Media 1MB throughput @ chunk legacy JSON/b64 @ 12 KiB raw: n=5  min=174.55 MB/s  median=219.24 MB/s  p95=292.83 MB/s  mean=226.98 MB/s  max=302.69 MB/s  (localhost TCP)
  → Media 1MB time @ chunk binary default (65536 B = 64 KiB): n=5  min=2.32 ms  median=2.42 ms  p95=3.13 ms  mean=2.60 ms  max=3.23 ms  (localhost TCP)
  → Media 1MB throughput @ chunk binary default (65536 B = 64 KiB): n=5  min=309.68 MB/s  median=413.96 MB/s  p95=430.60 MB/s  mean=390.22 MB/s  max=431.31 MB/s  (localhost TCP)
  → Media 1MB time @ chunk binary 32 KiB raw: n=5  min=2.46 ms  median=2.50 ms  p95=3.42 ms  mean=2.75 ms  max=3.61 ms  (localhost TCP)
  → Media 1MB throughput @ chunk binary 32 KiB raw: n=5  min=276.98 MB/s  median=400.71 MB/s  p95=405.55 MB/s  mean=372.10 MB/s  max=406.17 MB/s  (localhost TCP)

=== 5. Video-call setup (offer → connectionState connected) ===
  → Video-call setup (offer → connectionState 'connected'): n=7  min=197.8 ms  median=263.9 ms  p95=399.9 ms  mean=277.3 ms  max=440.2 ms  (werift, host ICE only)

=== 6. Group fan-out (N=3, N=6) ===
  → Group fan-out N=3 (1→2, all received): n=5  min=5.04 ms  median=5.93 ms  p95=6.17 ms  mean=5.73 ms  max=6.19 ms  (full-mesh room broadcast)
  → Group fan-out N=6 (1→5, all received): n=5  min=5.19 ms  median=5.89 ms  p95=6.57 ms  mean=5.92 ms  max=6.69 ms  (full-mesh room broadcast)

Suite finished in 5.6s
```
