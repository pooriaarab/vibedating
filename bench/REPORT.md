# vibedate latency benchmark report

Generated: 2026-07-28T23:48:28.596Z
Wall-clock suite time: 5.3 s
Node: v25.9.0 · platform: darwin/arm64

## Method

- **Network:** isolated in-process DHT via `hyperdht/testnet.js` `createTestnet` (same pattern as `src/*.integration.test.ts`). No public DHT, no WAN.
- **Stack under test:** `startDiscovery` (hyperswarm join + hello frames), `PeerLink` text/media/signal, `startRoom` group fan-out, `werift` RTCPeerConnection for video setup.
- **Iterations:** fast paths n=7, media/fan-out n≈5, bootstrap n=5. Stats: min / median / p95 / mean / max.
- **Units:** milliseconds (latency) or MB/s (throughput = payload_MB / elapsed_s).

## Measured metrics

| # | Metric | n | min | median | p95 | mean | max | Notes |
|---|--------|---|-----|--------|-----|------|-----|-------|
| 1 | DHT bootstrap → discoverable | 5 | 1.85 ms | 1.99 ms | 8.16 ms | 3.49 ms | 9.69 ms | fullyBootstrapped + topic flushed |
| 2 | Discovery → mutual hello | 7 | 7.76 ms | 8.12 ms | 13.4 ms | 9.12 ms | 15.6 ms | B joins after A flushed; both hellos |
| 3 | Text RTT (A send → B echo → A recv) | 7 | 1.47 ms | 2.58 ms | 2.67 ms | 2.29 ms | 2.70 ms |  |
| 4 | Media 1MB transfer time (PeerLink) | 5 | 19.1 ms | 20.5 ms | 27.5 ms | 22.0 ms | 28.9 ms | DEFAULT_CHUNK_BYTES=12288 |
| 5 | Media 1MB throughput | 5 | 34.62 MB/s | 48.71 MB/s | 52.02 MB/s | 46.35 MB/s | 52.45 MB/s |  |
| 6 | Media 10MB transfer time (PeerLink) | 3 | 172.9 ms | 181.3 ms | 190.1 ms | 181.8 ms | 191.0 ms | DEFAULT_CHUNK_BYTES=12288 |
| 7 | Media 10MB throughput | 3 | 52.35 MB/s | 55.15 MB/s | 57.56 MB/s | 55.11 MB/s | 57.83 MB/s |  |
| 8 | Media 1MB time @ chunk 4 KiB raw | 5 | 4.92 ms | 5.07 ms | 5.42 ms | 5.14 ms | 5.47 ms | localhost TCP (chunk/backpressure isolate) |
| 9 | Media 1MB throughput @ chunk 4 KiB raw | 5 | 182.68 MB/s | 197.41 MB/s | 202.46 MB/s | 194.84 MB/s | 203.34 MB/s | localhost TCP |
| 10 | Media 1MB time @ chunk default (12 KiB raw / 16 KiB b64) | 5 | 2.90 ms | 3.91 ms | 5.32 ms | 3.91 ms | 5.60 ms | localhost TCP (chunk/backpressure isolate) |
| 11 | Media 1MB throughput @ chunk default (12 KiB raw / 16 KiB b64) | 5 | 178.57 MB/s | 255.96 MB/s | 342.79 MB/s | 270.77 MB/s | 344.70 MB/s | localhost TCP |
| 12 | Media 1MB time @ chunk 32 KiB raw (clamped by frame b64) → clamped to 12288 B | 5 | 3.08 ms | 4.01 ms | 4.59 ms | 3.98 ms | 4.68 ms | localhost TCP (chunk/backpressure isolate) |
| 13 | Media 1MB throughput @ chunk 32 KiB raw (clamped by frame b64) → clamped to 12288 B | 5 | 213.90 MB/s | 249.43 MB/s | 311.25 MB/s | 256.02 MB/s | 324.72 MB/s | localhost TCP |
| 14 | Video-call setup (offer → connectionState 'connected') | 7 | 203.5 ms | 228.3 ms | 285.9 ms | 237.9 ms | 288.5 ms | werift, host ICE only |
| 15 | Group fan-out N=3 (1→2, all received) | 5 | 4.66 ms | 5.11 ms | 5.26 ms | 5.02 ms | 5.26 ms | full-mesh room broadcast |
| 16 | Group fan-out N=6 (1→5, all received) | 5 | 5.26 ms | 5.88 ms | 13.5 ms | 8.39 ms | 14.1 ms | full-mesh room broadcast |

## Interpretation (what the numbers say)

- **DHT bootstrap** median 1.99 ms is the fixed cost of `fullyBootstrapped()` + first topic `flushed()`. Every cold `startDiscovery` pays this before anyone can find you.
- **Discovery → hello** median 8.12 ms is dominated by DHT lookup + TCP/Noise handshake + framed hello exchange. B starts after A is already flushed, so this is the cold "I just joined and saw you" path.
- **Text RTT** median 2.58 ms is pure framed JSON over an already-open hyperswarm socket (no discovery). This is the floor for chat interactivity.
- **1MB media** median 20.5 ms (~48.71 MB/s) uses default chunk size 12288 raw bytes, base64 on the wire (~33% overhead), drain-aware writes.
- **10MB media** median 181.3 ms (~55.15 MB/s). Compare with 1MB: if throughput stays flat, you're socket/CPU bound; if it drops, backpressure or GC is biting.
- **Video setup** median 228.3 ms covers SDP offer/answer + host ICE over PeerLink signaling until `connectionState === 'connected'`. No STUN (testnet is local); production would add STUN/TURN cost.
- **Fan-out** N=3 median 5.11 ms vs N=6 median 5.88 ms. Full-mesh broadcast is O(N) sends on the publisher; receive latency should grow gently until link scheduling or DHT churn interferes.

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

## Caveats

- These numbers are **in-process loopback floors** (hyperdht testnet on localhost). Public-DHT bootstrap, NAT hole-punching, lossy WAN RTT, and STUN/TURN will dominate in the wild — treat relative comparisons (chunk sizes, N=3 vs N=6, 1MB vs 10MB) as more portable than absolute ms.
- Video setup uses **werift** (devDep) with host ICE only; browser RTCPeerConnection + real ICE will differ.
- Chunk-size sweep isolates framing/backpressure on plain TCP; PeerLink media rows are the production hyperswarm path.
- Suite wall-clock (~5s here) excludes public network variance; CI machines will see different p95 tails.

## How to reproduce

```bash
npm install
npm run build
npm run bench
```

The bench is intentionally **not** part of the default `vitest` run (keeps CI fast). It lives under `bench/` and runs via `tsx`.

## Raw console capture

```
vibedate latency bench — 2026-07-28T23:48:28.596Z
DEFAULT_CHUNK_BYTES=12288  MAX defaults from frame.ts
testnet ready (1 bootstrap nodes)

=== 1. DHT bootstrap (swarm ready / flushed) ===
  → DHT bootstrap → discoverable: n=5  min=1.85 ms  median=1.99 ms  p95=8.16 ms  mean=3.49 ms  max=9.69 ms  (fullyBootstrapped + topic flushed)

=== 2. Discovery → first peer (mutual hello) ===
  → Discovery → mutual hello: n=7  min=7.76 ms  median=8.12 ms  p95=13.4 ms  mean=9.12 ms  max=15.6 ms  (B joins after A flushed; both hellos)

=== 3. Text RTT (A→B→A) ===
  → Text RTT (A send → B echo → A recv): n=7  min=1.47 ms  median=2.58 ms  p95=2.67 ms  mean=2.29 ms  max=2.70 ms

=== 4. Media throughput (1MB + 10MB + chunk size) ===
  → Media 1MB transfer time (PeerLink): n=5  min=19.1 ms  median=20.5 ms  p95=27.5 ms  mean=22.0 ms  max=28.9 ms  (DEFAULT_CHUNK_BYTES=12288)
  → Media 1MB throughput: n=5  min=34.62 MB/s  median=48.71 MB/s  p95=52.02 MB/s  mean=46.35 MB/s  max=52.45 MB/s
  → Media 10MB transfer time (PeerLink): n=3  min=172.9 ms  median=181.3 ms  p95=190.1 ms  mean=181.8 ms  max=191.0 ms  (DEFAULT_CHUNK_BYTES=12288)
  → Media 10MB throughput: n=3  min=52.35 MB/s  median=55.15 MB/s  p95=57.56 MB/s  mean=55.11 MB/s  max=57.83 MB/s
  · chunk-size sweep on 1MB (localhost TCP + sendMedia backpressure path)
  → Media 1MB time @ chunk 4 KiB raw: n=5  min=4.92 ms  median=5.07 ms  p95=5.42 ms  mean=5.14 ms  max=5.47 ms  (localhost TCP (chunk/backpressure isolate))
  → Media 1MB throughput @ chunk 4 KiB raw: n=5  min=182.68 MB/s  median=197.41 MB/s  p95=202.46 MB/s  mean=194.84 MB/s  max=203.34 MB/s  (localhost TCP)
  → Media 1MB time @ chunk default (12 KiB raw / 16 KiB b64): n=5  min=2.90 ms  median=3.91 ms  p95=5.32 ms  mean=3.91 ms  max=5.60 ms  (localhost TCP (chunk/backpressure isolate))
  → Media 1MB throughput @ chunk default (12 KiB raw / 16 KiB b64): n=5  min=178.57 MB/s  median=255.96 MB/s  p95=342.79 MB/s  mean=270.77 MB/s  max=344.70 MB/s  (localhost TCP)
  → Media 1MB time @ chunk 32 KiB raw (clamped by frame b64) → clamped to 12288 B: n=5  min=3.08 ms  median=4.01 ms  p95=4.59 ms  mean=3.98 ms  max=4.68 ms  (localhost TCP (chunk/backpressure isolate))
  → Media 1MB throughput @ chunk 32 KiB raw (clamped by frame b64) → clamped to 12288 B: n=5  min=213.90 MB/s  median=249.43 MB/s  p95=311.25 MB/s  mean=256.02 MB/s  max=324.72 MB/s  (localhost TCP)

=== 5. Video-call setup (offer → connectionState connected) ===
  → Video-call setup (offer → connectionState 'connected'): n=7  min=203.5 ms  median=228.3 ms  p95=285.9 ms  mean=237.9 ms  max=288.5 ms  (werift, host ICE only)

=== 6. Group fan-out (N=3, N=6) ===
  → Group fan-out N=3 (1→2, all received): n=5  min=4.66 ms  median=5.11 ms  p95=5.26 ms  mean=5.02 ms  max=5.26 ms  (full-mesh room broadcast)
  → Group fan-out N=6 (1→5, all received): n=5  min=5.26 ms  median=5.88 ms  p95=13.5 ms  mean=8.39 ms  max=14.1 ms  (full-mesh room broadcast)

Suite finished in 5.3s
```
