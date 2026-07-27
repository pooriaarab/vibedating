# vibedating Live (text → media/video) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Turn vibedating's existing P2P *discovery* into a live *session* — same-league peers chat in real time (text), reroll with omegle-style `next`, then exchange images/video, over the hyperswarm socket that already exists. No hosting.

**Architecture:** `src/p2p.ts` already discovers same-league peers over the hyperswarm DHT and opens an encrypted socket per peer, but only exchanges a one-shot hello. We (1) generalize the wire protocol from one hello line to typed newline-JSON **frames**, (2) surface each connection as a **PeerLink** (send/onMessage/close), (3) add a **pairing policy** (omegle auto-pair + `next`; dating pick-a-handle), (4) wire a `vibedating live` CLI + web pane. Media/video (increment 2) reuses the frame channel as WebRTC signaling. All e2e runs on hyperdht's in-process `createTestnet` = N simulated machines, never the public DHT.

**Tech Stack:** TypeScript, hyperswarm/hyperdht (present), vitest (present), `@pooriaarab/vibe-core`. Increment 2 adds `werift` (pure-TS WebRTC) for Node A/V; browser WebRTC in the web app.

---

## File structure

- `src/frame.ts` (new) — wire frame types + `serializeFrame`/`parseFrame` (allowlist-hardened, mirrors `parseHandshake`). One responsibility: the protocol.
- `src/link.ts` (new) — `PeerLink` wrapping one peer socket: `send(text)`, `onMessage`, `onClose`, `close()`. Depends on `frame.ts`.
- `src/p2p.ts` (modify) — `startDiscovery` gains `onLink(link: PeerLink)` callback exposing each connection; hello stays the first frame. No behavior change for existing callers (callback optional).
- `src/pairing.ts` (new) — omegle auto-pair + `next` policy over the live `peers`/links; and dating "open a session with handle X".
- `src/cli.ts` (modify) — add `live` command (+ `--dating` flag to pick vs auto-pair).
- `src/mcp.ts` (modify) — add `live_start` / `live_send` / `live_next` tools.
- `src/live.integration.test.ts` (new) — multi-node testnet e2e: text both ways + `next`.
- Increment 2: `src/media.ts` (new, chunked file transfer), `src/webrtc.ts` (new, A/V over frame signaling), tests alongside.
- Cleanup: remove the committed `<<<<<<< HEAD` conflict marker in `src/p2p.integration.test.ts` comment (lines ~6-10).

---

## Increment 1 — live text chat + `next`

### Task 1: Frame protocol (`src/frame.ts`)

**Files:** Create `src/frame.ts`; Test `src/frame.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
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
```

- [ ] **Step 2: Run — expect FAIL** (`npx vitest run src/frame.test.ts`).

- [ ] **Step 3: Implement `src/frame.ts`**

```ts
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
```

- [ ] **Step 4: Run — expect PASS.** **Step 5: Commit** `feat(live): frame protocol`.

### Task 2: PeerLink (`src/link.ts`)

**Files:** Create `src/link.ts`; Test `src/link.test.ts` (use a `PassThrough` duplex pair as fake sockets).

- [ ] **Step 1: Failing test** — two `PassThrough` streams cross-wired; `LinkA.send('hi')` → `LinkB.onMessage` fires with `{text:'hi'}`; `LinkA.close()` → `LinkB.onClose` fires (via `bye`).
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement.** `PeerLink` wraps a `Duplex` (the hyperswarm socket). Buffers by `\n`, `parseFrame`s each line, dispatches `msg`→onMessage, `bye`→onClose. `send(text)` writes a `msg` frame with `id=randomUUID()`, `at=Date.now()`. `close()` writes `bye` then ends the socket. Ignores malformed frames (parseFrame null). Interface:

```ts
export interface PeerLink {
  readonly hello: { handle: string; league: string; harness: string };
  send(text: string): void;
  onMessage(cb: (m: { id: string; text: string; at: number }) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}
```

- [ ] **Step 4: PASS. Step 5: Commit** `feat(live): PeerLink`.

### Task 3: Surface links from discovery (`src/p2p.ts`)

**Files:** Modify `src/p2p.ts` (the `connection` handler, ~line 229); Test extends `src/live.integration.test.ts` (Task 4).

- [ ] **Step 1..**: Add optional `onLink?: (link: PeerLink) => void` to `DiscoveryOptions`. In the `connection` handler, after a valid same-league hello is recorded, construct a `PeerLink` over the same `socket` (the hello was frame #1; subsequent frames flow to the link) and call `onLink(link)`. Existing `onPeer`/notify behavior unchanged. Keep the hello send as a `{t:'hello',...}` frame via `serializeFrame` (replaces the ad-hoc `serializeHandshake`; keep `serializeHandshake` as a thin wrapper so existing tests pass, or update them).
- [ ] Commit `feat(live): expose PeerLink from startDiscovery`.

### Task 4: Multi-machine e2e — text both ways + next (`src/live.integration.test.ts`)

**Files:** Create `src/live.integration.test.ts` (copy the testnet scaffold from `p2p.integration.test.ts`).

- [ ] **Step 1: Write the e2e test** (this is the "simulate multiple machines" proof):

```ts
// Two startDiscovery nodes on an in-process testnet DHT (createTestnet), each
// captures its PeerLink, exchange text both ways, then A closes ('next') and
// B sees onClose.
it('two machines chat both ways, then next closes the link', async () => {
  const topic = randomTopic();
  let linkA: PeerLink | undefined, linkB: PeerLink | undefined;
  const gotA: string[] = [], gotB: string[] = [];
  const a = await spawnWithLink(ALICE, topic, (l) => { linkA = l; l.onMessage(m => gotA.push(m.text)); });
  const b = await spawnWithLink(BOB, topic, (l) => { linkB = l; l.onMessage(m => gotB.push(m.text)); });
  await Promise.all([a.ready, b.ready]);
  await waitFor(() => !!linkA && !!linkB, 15_000);
  linkA!.send('hey bob'); linkB!.send('hey alice');
  expect(await waitFor(() => gotB.includes('hey bob') && gotA.includes('hey alice'), 10_000)).toBe(true);
  let bClosed = false; linkB!.onClose(() => { bClosed = true; });
  linkA!.close(); // omegle "next"
  expect(await waitFor(() => bClosed, 10_000)).toBe(true);
}, 45_000);
```

- [ ] `spawnWithLink` = `spawn` + pass `onLink`. Run — implement Task 3 until PASS. Commit `test(live): multi-node text e2e`.

### Task 5: Pairing policy (`src/pairing.ts`)

**Files:** Create `src/pairing.ts`; Test `src/pairing.test.ts` (inject a fake link factory — no network).

- [ ] Omegle: `LivePairing` holds available links, exposes `current()`, `next()` (close current, pick next available, else wait for `onLink`). Dating: `open(handle)` picks the link whose `hello.handle === handle`. Pure over an injected link set. Test `next()` advances and closes prior. Commit.

### Task 6: CLI `live` command (`src/cli.ts`)

- [ ] Add `'live'` to `Command`; parse `--dating`. `cmdLive`: print `LIVE_NOTICE`, gate on `share:live` consent (reuse `canShareLive`/`grantLiveConsent`), `startDiscovery({...,onLink})` feeding a `LivePairing`, read stdin lines → `current().send(line)`; `/next` → `pairing.next()`; `/quit` → close+exit. Print incoming `onMessage` to stdout. Manual smoke only (no unit test for the readline loop; the protocol + pairing are tested). Commit.

### Task 7: MCP + web pane
- [ ] MCP tools `live_start`/`live_send`/`live_next` over a module-held `LivePairing`. Web: a chat pane in `web-app-html.ts` posting to a local `/live` route in `server.ts` bridging to the same pairing. Commit each.

---

## Increment 2 — media/video

### Task 8: Chunked file/image transfer (`src/media.ts`)
- [ ] New frame types `{t:'media-start',id,mime,size,name}`, `{t:'media-chunk',id,seq,b64}`, `{t:'media-end',id}`. Cap total size (e.g. 25MB), cap chunk (16KB b64), enforce backpressure (`socket.write` returns false → await `drain`). Reassemble to a temp file, surface `onMedia({mime,path})`. Extend `frame.ts` + `parseFrame` with the new types (same allowlist rigor) + tests. E2e: send a small PNG A→B on the testnet, assert bytes match. Commit.

### Task 9: Live A/V over WebRTC (`src/webrtc.ts`)
- [ ] Add dep `werift` (pure-TS WebRTC, no native build). New frames `{t:'rtc-sdp',sdp,kind}`, `{t:'rtc-ice',candidate}`. The hyperswarm PeerLink is the **signaling channel**: offerer creates `RTCPeerConnection`, sends SDP/ICE as frames; answerer replies; RTP media flows P2P. CLI: capture webcam/mic is out-of-scope for terminal (document that A/V is browser-app-first); the web app uses native `getUserMedia` + browser `RTCPeerConnection`, signaling bridged through the local server to the same PeerLink. Node/CLI path via werift is for tests + headless. E2e: two werift peers negotiate over two testnet PeerLinks, assert `connectionState==='connected'` and one media track flows. Commit.

---

## Increment 3 — all-packages multi-machine e2e (verification sweep)

Each is its own task; goal = prove the package actually works when multiple instances run, not just unit tests.

### Task 10: vibedating full e2e
- [ ] Already covered by Tasks 4/8/9. Add one `connect → discover → live → next` scripted CLI smoke over a testnet (env-injected bootstrap) run in CI. Commit.

### Task 11: vibelive multi-client e2e
- [ ] In `pooriaarab/vibelive`: spin host + N clients (in-process or child procs) through the relay; assert every client receives the ordered output log + a cursor update, and the write-arbitration/driver-token serializes concurrent writers (property-style: interleave K writers, assert single-writer-at-a-time). Reuse/extend its existing client/host/relay tests. Commit.

### Task 12: vibedonate mesh e2e
- [ ] In `pooriaarab/vibedonate`: simulate ≥2 donor peers + 1 consumer over the mesh; assert an inference job routes to a donor and returns, and that consent/metering gates hold (no route without grant). Commit.

### Task 13: vibeshare handoff e2e
- [ ] In `pooriaarab/vibeshare`: a share URL → spectate (read-only) and → invite-into-vibelive handoff; assert spectator cannot write, invitee joins the vibelive session. Commit.

### Task 14: single-machine CLI smoke (viberadio-fm, vibemovie)
- [ ] No P2P. `npx viberadio-fm say "..."` produces audio artifact/exit 0; `npx vibemovie render` produces the Hyperframes HTML/exit 0. One smoke test each in CI. Commit.

---

## Notes / risks
- **werift** is pure-TS (no node-gyp) → CI-safe; if A/V proves flaky headless, keep increment-2 A/V browser-app-only and ship media-file transfer (Task 8) as the CLI media path.
- Concurrency hazard (both live modes): two peers sending simultaneously is fine (independent frames); the *arbitration* hazard is vibelive's, not vibedating's (1:1 here).
- Privacy invariant extends: every new frame type goes through `parseFrame`'s allowlist — no raw-usage field can ride a media/rtc frame.
