import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { VibeEvent } from '@pooriaarab/vibe-core';
import { CANDIDATES } from './index.js';
import type { RtcFrame } from './frame.js';
import {
  createLiveBridge,
  createRoomBridge,
  startServer,
  type LiveBridge,
  type LiveMessage,
  type LivePeerInfo,
  type RoomBridge,
  type RoomSignal,
  type StartedServer,
  type StartServerOptions,
} from './server.js';
import type { PeerLink } from './link.js';
import type { RoomSession } from './room.js';

// Hermetic state dir so the test never touches ~/.vibedating.
const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'vibedating-test-'));
afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

async function withServer(
  fn: (s: StartedServer) => Promise<void>,
  opts: StartServerOptions = {},
): Promise<void> {
  const s = await startServer({ port: 0, dir: tmpDir, ...opts });
  try {
    await fn(s);
  } finally {
    await new Promise<void>((resolve) => s.server.close(() => resolve()));
  }
}

/** Connect with the demo snapshot; returns the league the profile landed in. */
async function connect(url: string): Promise<string> {
  const res = await fetch(`${url}/api/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ harness: 'claude-code', handle: '@tester' }),
  });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { league: string };
  return json.league;
}

function postMatch(url: string, handle: string): Promise<Response> {
  return fetch(`${url}/api/match`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle }),
  });
}

/** A fake LiveBridge that records what the server tries to send and lets a
 *  test pre-queue frames/messages for the long-polls to return. */
function fakeBridge(seedPeers: readonly LivePeerInfo[] = []): LiveBridge & {
  sent: Array<{ handle: string; frame: RtcFrame }>;
  queue: Map<string, RtcFrame[]>;
  sentMessages: Array<{ handle: string; text: string }>;
  msgQueue: Map<string, LiveMessage[]>;
} {
  const sent: Array<{ handle: string; frame: RtcFrame }> = [];
  const queue = new Map<string, RtcFrame[]>();
  const sentMessages: Array<{ handle: string; text: string }> = [];
  const msgQueue = new Map<string, LiveMessage[]>();
  const peers: LivePeerInfo[] = [...seedPeers];
  return {
    peers,
    addLink() {
      /* not exercised here */
    },
    sendSignal(handle, frame) {
      sent.push({ handle, frame });
    },
    async pollSignal(_handle) {
      const q = queue.get(_handle) ?? [];
      if (q.length > 0) return q.shift() ?? null;
      return null; // never block in tests
    },
    sendMessage(handle, text) {
      sentMessages.push({ handle, text });
    },
    async pollMessage(_handle) {
      const q = msgQueue.get(_handle) ?? [];
      if (q.length > 0) return q.shift() ?? null;
      return null; // never block in tests
    },
    sent,
    queue,
    sentMessages,
    msgQueue,
  };
}

describe('local web server', () => {
  it('responds 200 on / with text/html', async () => {
    await withServer(async ({ url }) => {
      const res = await fetch(`${url}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type') ?? '').toContain('text/html');
      const body = await res.text();
      expect(body).toContain('vibedating');
      expect(body).toContain('/api/state');
    });
  });

  it('exposes /api/state as JSON with a candidates array', async () => {
    await withServer(async ({ url }) => {
      const res = await fetch(`${url}/api/state`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type') ?? '').toContain('application/json');
      const json = (await res.json()) as { connected: boolean; candidates: unknown[] };
      expect(Array.isArray(json.candidates)).toBe(true);
      expect(json.connected).toBe(false); // fresh tmp dir, never connected
    });
  });

  it('connects via POST /api/connect then reflects a league', async () => {
    await withServer(async ({ url }) => {
      const res = await fetch(`${url}/api/connect`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ harness: 'claude-code', handle: '@tester' }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        connected: boolean;
        handle: string;
        league: string;
        candidates: unknown[];
      };
      expect(json.connected).toBe(true);
      expect(json.handle).toBe('@tester');
      expect(json.league).toBeTruthy();
      expect(json.candidates.length).toBeGreaterThan(0);

      // state now persists across requests in this dir
      const state = (await (await fetch(`${url}/api/state`)).json()) as { connected: boolean };
      expect(state.connected).toBe(true);
    });
  });

  it('404s an unknown path', async () => {
    await withServer(async ({ url }) => {
      const res = await fetch(`${url}/nope`);
      expect(res.status).toBe(404);
    });
  });
});

describe('POST /api/match', () => {
  it('notifies exactly once when a same-league match is confirmed', async () => {
    const events: VibeEvent[] = [];
    await withServer(
      async ({ url }) => {
        const league = await connect(url);
        const same = CANDIDATES.find((c) => c.league === league);
        expect(same).toBeDefined();

        const res = await postMatch(url, (same as (typeof CANDIDATES)[number]).handle);
        expect(res.status).toBe(200);
        const json = (await res.json()) as { matched: boolean };
        expect(json.matched).toBe(true);

        expect(events).toHaveLength(1);
        const e = events[0];
        expect(e?.kind).toBe('match');
        expect(e?.payload?.['summary']).toBe(
          `matched with ${(same as (typeof CANDIDATES)[number]).handle} - SAME LEAGUE`,
        );
        expect(e?.payload?.['league']).toBe(league);
      },
      { notify: (e) => events.push(e) },
    );
  });

  it('does not notify for a different-league candidate (adjacent included)', async () => {
    const events: VibeEvent[] = [];
    await withServer(
      async ({ url }) => {
        const league = await connect(url);
        const other = CANDIDATES.find((c) => c.league !== league);
        expect(other).toBeDefined();

        const res = await postMatch(url, (other as (typeof CANDIDATES)[number]).handle);
        expect(res.status).toBe(200);
        const json = (await res.json()) as { matched: boolean };
        expect(json.matched).toBe(false);
        expect(events).toHaveLength(0);
      },
      { notify: (e) => events.push(e) },
    );
  });

  it('404s an unknown candidate without notifying', async () => {
    const events: VibeEvent[] = [];
    await withServer(
      async ({ url }) => {
        await connect(url);
        const res = await postMatch(url, '@nobody');
        expect(res.status).toBe(404);
        expect(events).toHaveLength(0);
      },
      { notify: (e) => events.push(e) },
    );
  });

  it('409s when never connected', async () => {
    const fresh = mkdtempSync(path.join(os.tmpdir(), 'vibedating-fresh-'));
    const s = await startServer({ port: 0, dir: fresh, notify: () => {} });
    try {
      const res = await postMatch(s.url, CANDIDATES[0]?.handle ?? '@x');
      expect(res.status).toBe(409);
    } finally {
      await new Promise<void>((resolve) => s.server.close(() => resolve()));
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});

describe('live A/V signaling bridge (/api/live/peers, /live/signal)', () => {
  function postSignal(url: string, body: unknown): Promise<Response> {
    return fetch(`${url}/live/signal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('GET /api/live/peers is an empty array when no bridge is attached', async () => {
    await withServer(async ({ url }) => {
      const res = await fetch(`${url}/api/live/peers`);
      expect(res.status).toBe(200);
      const json = (await res.json()) as { peers: unknown[] };
      expect(json.peers).toEqual([]);
    });
  });

  it('GET /api/live/peers reflects the bridge peer snapshot', async () => {
    const bridge = fakeBridge([
      { handle: '@alice', league: '10M', harness: 'codex' },
    ]);
    await withServer(
      async ({ url }) => {
        const res = await fetch(`${url}/api/live/peers`);
        expect(res.status).toBe(200);
        const json = (await res.json()) as { peers: LivePeerInfo[] };
        expect(json.peers).toEqual([
          { handle: '@alice', league: '10M', harness: 'codex' },
        ]);
      },
      { live: bridge },
    );
  });

  it('GET /api/live/peers carries the verification marks when present', async () => {
    const bridge = fakeBridge([
      { handle: '@bob', league: '10M', harness: 'codex', verified: true, identityVerified: true },
      { handle: '@legacy', league: '5M', harness: 'claude-code' },
    ]);
    await withServer(
      async ({ url }) => {
        const json = (await (await fetch(`${url}/api/live/peers`)).json()) as {
          peers: LivePeerInfo[];
        };
        expect(json.peers).toEqual([
          { handle: '@bob', league: '10M', harness: 'codex', verified: true, identityVerified: true },
          { handle: '@legacy', league: '5M', harness: 'claude-code' },
        ]);
      },
      { live: bridge },
    );
  });

  it('createLiveBridge maps each hello to the display shape — marks kept, pubkey dropped', () => {
    const bridge = createLiveBridge();
    const fakeLink = {
      hello: {
        handle: '@z',
        league: '5M',
        harness: 'codex',
        verified: true,
        identityVerified: true,
        pubkey: 'ab'.repeat(32),
      },
      onSignal() {},
      onMessage() {},
      onClose() {},
    } as unknown as PeerLink;
    bridge.addLink(fakeLink);
    expect(bridge.peers).toEqual([
      { handle: '@z', league: '5M', harness: 'codex', verified: true, identityVerified: true },
    ]);
  });

  it('POST /live/signal relays a valid rtc-offer to the bridge', async () => {
    const bridge = fakeBridge();
    await withServer(
      async ({ url }) => {
        const res = await postSignal(url, {
          handle: '@alice',
          frame: { t: 'rtc-offer', sdp: 'v=0\r\n' },
        });
        expect(res.status).toBe(200);
        expect((await res.json()) as { ok: boolean }).toStrictEqual({ ok: true });
        expect(bridge.sent).toEqual([
          { handle: '@alice', frame: { t: 'rtc-offer', sdp: 'v=0\r\n' } },
        ]);
      },
      { live: bridge },
    );
  });

  it('POST /live/signal STRIPS extra keys the browser tries to attach (allowlist)', async () => {
    const bridge = fakeBridge();
    await withServer(
      async ({ url }) => {
        const res = await postSignal(url, {
          handle: '@alice',
          frame: {
            t: 'rtc-offer',
            sdp: 'v=0\r\n',
            leak: 'raw-usage',
            impersonator: true,
          },
        });
        expect(res.status).toBe(200);
        // The frame that reached the bridge must be the allowlisted shape ONLY.
        expect(bridge.sent).toHaveLength(1);
        expect(bridge.sent[0]!.frame).toEqual({ t: 'rtc-offer', sdp: 'v=0\r\n' });
      },
      { live: bridge },
    );
  });

  it('POST /live/signal 400s on a malformed / oversized frame and does NOT relay', async () => {
    const bridge = fakeBridge();
    await withServer(
      async ({ url }) => {
        // missing sdp
        const r1 = await postSignal(url, { handle: '@a', frame: { t: 'rtc-offer' } });
        expect(r1.status).toBe(400);
        // oversized candidate (> 4 KiB)
        const r2 = await postSignal(url, {
          handle: '@a',
          frame: { t: 'rtc-ice', candidate: 'x'.repeat(5000) },
        });
        expect(r2.status).toBe(400);
        // a non-rtc frame type must be rejected too
        const r3 = await postSignal(url, {
          handle: '@a',
          frame: { t: 'msg', id: '1', text: 'hi', at: 1 },
        });
        expect(r3.status).toBe(400);
        // nothing leaked through to the bridge
        expect(bridge.sent).toEqual([]);
      },
      { live: bridge },
    );
  });

  it('POST /live/signal 400s when no bridge is attached', async () => {
    await withServer(async ({ url }) => {
      const res = await postSignal(url, { handle: '@a', frame: { t: 'rtc-offer', sdp: 'v=0' } });
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: string };
      expect(json.error).toBe('live-not-attached');
    });
  });

  it('GET /live/signal long-poll returns a queued frame, then null when empty', async () => {
    const bridge = fakeBridge();
    bridge.queue.set('@alice', [{ t: 'rtc-answer', sdp: 'v=0\r\n' }]);
    await withServer(
      async ({ url }) => {
        const r1 = await fetch(`${url}/live/signal?handle=${encodeURIComponent('@alice')}`);
        expect(r1.status).toBe(200);
        expect((await r1.json()) as { frame: RtcFrame | null }).toStrictEqual({
          frame: { t: 'rtc-answer', sdp: 'v=0\r\n' },
        });
        // queue drained → next poll returns null immediately
        const r2 = await fetch(`${url}/live/signal?handle=${encodeURIComponent('@alice')}`);
        expect((await r2.json()) as { frame: RtcFrame | null }).toStrictEqual({ frame: null });
      },
      { live: bridge },
    );
  });

  it('GET /live/signal 400s on a missing handle', async () => {
    const bridge = fakeBridge();
    await withServer(
      async ({ url }) => {
        const res = await fetch(`${url}/live/signal`);
        expect(res.status).toBe(400);
      },
      { live: bridge },
    );
  });
});

describe('live text chat bridge (/live/message)', () => {
  function postMessage(url: string, body: unknown): Promise<Response> {
    return fetch(`${url}/live/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('POST /live/message relays valid text — forged id/at/leak keys stripped by construction', async () => {
    const bridge = fakeBridge();
    await withServer(
      async ({ url }) => {
        const res = await postMessage(url, {
          handle: '@alice',
          text: 'hi there',
          leak: 'raw-usage',
          id: 'forged',
          at: 0,
        });
        expect(res.status).toBe(200);
        expect((await res.json()) as { ok: boolean }).toStrictEqual({ ok: true });
        // Only the text reaches the bridge — the msg frame's id/at are minted
        // server-side, so a forged id/at/leak on the body can never reach the wire.
        expect(bridge.sentMessages).toEqual([{ handle: '@alice', text: 'hi there' }]);
      },
      { live: bridge },
    );
  });

  it('POST /live/message 400s on empty / oversized / non-string / missing text and does NOT relay', async () => {
    const bridge = fakeBridge();
    await withServer(
      async ({ url }) => {
        const r1 = await postMessage(url, { handle: '@a', text: '' });
        expect(r1.status).toBe(400);
        const r2 = await postMessage(url, { handle: '@a', text: 'x'.repeat(4001) });
        expect(r2.status).toBe(400);
        const r3 = await postMessage(url, { handle: '@a', text: 42 });
        expect(r3.status).toBe(400);
        const r4 = await postMessage(url, { handle: '@a' });
        expect(r4.status).toBe(400);
        const r5 = await postMessage(url, { text: 'hi' });
        expect(r5.status).toBe(400);
        expect(bridge.sentMessages).toEqual([]);
      },
      { live: bridge },
    );
  });

  it('POST /live/message accepts exactly MAX_TEXT_LEN chars', async () => {
    const bridge = fakeBridge();
    await withServer(
      async ({ url }) => {
        const res = await postMessage(url, { handle: '@a', text: 'x'.repeat(4000) });
        expect(res.status).toBe(200);
        expect(bridge.sentMessages).toHaveLength(1);
      },
      { live: bridge },
    );
  });

  it('POST /live/message 400s when no bridge is attached', async () => {
    await withServer(async ({ url }) => {
      const res = await postMessage(url, { handle: '@a', text: 'hi' });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('live-not-attached');
    });
  });

  it('POST /live/message 400s on invalid JSON', async () => {
    const bridge = fakeBridge();
    await withServer(
      async ({ url }) => {
        const res = await fetch(`${url}/live/message`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{nope',
        });
        expect(res.status).toBe(400);
        expect(bridge.sentMessages).toEqual([]);
      },
      { live: bridge },
    );
  });

  it('GET /live/message long-poll returns a queued message, then null when empty', async () => {
    const bridge = fakeBridge();
    bridge.msgQueue.set('@alice', [{ id: 'm1', text: 'yo', at: 123 }]);
    await withServer(
      async ({ url }) => {
        const r1 = await fetch(`${url}/live/message?handle=${encodeURIComponent('@alice')}`);
        expect(r1.status).toBe(200);
        expect((await r1.json()) as { message: LiveMessage | null }).toStrictEqual({
          message: { id: 'm1', text: 'yo', at: 123 },
        });
        const r2 = await fetch(`${url}/live/message?handle=${encodeURIComponent('@alice')}`);
        expect((await r2.json()) as { message: LiveMessage | null }).toStrictEqual({
          message: null,
        });
      },
      { live: bridge },
    );
  });

  it('GET /live/message 400s on a missing handle; without a bridge returns message:null', async () => {
    const bridge = fakeBridge();
    await withServer(
      async ({ url }) => {
        const res = await fetch(`${url}/live/message`);
        expect(res.status).toBe(400);
      },
      { live: bridge },
    );
    await withServer(async ({ url }) => {
      const res = await fetch(`${url}/live/message?handle=${encodeURIComponent('@a')}`);
      expect(res.status).toBe(200);
      expect((await res.json()) as { message: null; reason: string }).toStrictEqual({
        message: null,
        reason: 'live-not-attached',
      });
    });
  });

  it('createLiveBridge queues incoming messages per peer, caps the backlog, and sends via link.send', async () => {
    const bridge = createLiveBridge();
    let msgCb: ((m: LiveMessage) => void) | undefined;
    const sentTexts: string[] = [];
    const fakeLink = {
      hello: { handle: '@peer', league: '10M', harness: 'codex' },
      onSignal() {},
      onClose() {},
      onMessage(cb: (m: LiveMessage) => void) {
        msgCb = cb;
      },
      send(t: string) {
        sentTexts.push(t);
      },
    } as unknown as PeerLink;
    bridge.addLink(fakeLink);

    bridge.sendMessage('@peer', 'hi there');
    expect(sentTexts).toEqual(['hi there']);
    bridge.sendMessage('@ghost', 'no-op'); // unknown peer — silently dropped
    expect(sentTexts).toEqual(['hi there']);

    for (let i = 0; i < 205; i++) msgCb?.({ id: String(i), text: `m${i}`, at: i });
    const first = await bridge.pollMessage('@peer', 10);
    // Backlog capped at 200 — the oldest 5 were dropped.
    expect(first?.text).toBe('m5');
    expect(await bridge.pollMessage('@ghost', 10)).toBeNull();
  });
});

describe('room full-mesh signaling (/api/room, /room/signal)', () => {
  /** Minimal RoomBridge fake that records sends and serves pre-queued signals. */
  function fakeRoom(
    name = 'den',
    self = '@self',
    members: readonly LivePeerInfo[] = [],
  ): RoomBridge & {
    sent: Array<{ handle: string; frame: RtcFrame }>;
    queue: RoomSignal[];
  } {
    const sent: Array<{ handle: string; frame: RtcFrame }> = [];
    const queue: RoomSignal[] = [];
    return {
      name,
      self,
      members,
      attach() {
        /* not exercised */
      },
      broadcast() {
        /* not exercised */
      },
      async pollMessage() {
        return null;
      },
      sendSignal(handle, frame) {
        sent.push({ handle, frame });
      },
      async pollSignal(_handle) {
        if (queue.length > 0) return queue.shift() ?? null;
        return null;
      },
      sent,
      queue,
    };
  }

  it('GET /api/room returns null when no bridge is attached', async () => {
    await withServer(async ({ url }) => {
      const res = await fetch(`${url}/api/room`);
      expect(res.status).toBe(200);
      expect(await res.json()).toStrictEqual({ room: null, self: null, members: [] });
    });
  });

  it('GET /api/room returns room/self/members when a bridge is attached', async () => {
    const room = fakeRoom('den', '@alice', [
      { handle: '@bob', league: '10M', harness: 'codex' },
    ]);
    await withServer(
      async ({ url }) => {
        const res = await fetch(`${url}/api/room`);
        expect(res.status).toBe(200);
        expect(await res.json()).toStrictEqual({
          room: 'den',
          self: '@alice',
          members: [{ handle: '@bob', league: '10M', harness: 'codex' }],
        });
      },
      { room },
    );
  });

  it('GET /room/signal returns sender-tagged { from, rtc } frames', async () => {
    const room = fakeRoom();
    room.queue.push({ from: '@bob', rtc: { t: 'rtc-offer', sdp: 'v=0' } });
    await withServer(
      async ({ url }) => {
        const res = await fetch(`${url}/room/signal?handle=${encodeURIComponent('@self')}`);
        expect(res.status).toBe(200);
        expect(await res.json()).toStrictEqual({
          frame: { from: '@bob', rtc: { t: 'rtc-offer', sdp: 'v=0' } },
        });
        // Empty mailbox → null frame (no hang in tests).
        const res2 = await fetch(`${url}/room/signal?handle=${encodeURIComponent('@self')}`);
        expect(await res2.json()).toStrictEqual({ frame: null });
      },
      { room },
    );
  });

  it('GET /room/signal 400s without handle; without bridge returns frame:null', async () => {
    const room = fakeRoom();
    await withServer(
      async ({ url }) => {
        const res = await fetch(`${url}/room/signal`);
        expect(res.status).toBe(400);
      },
      { room },
    );
    await withServer(async ({ url }) => {
      const res = await fetch(`${url}/room/signal?handle=${encodeURIComponent('@a')}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toStrictEqual({ frame: null, reason: 'room-not-attached' });
    });
  });

  it('POST /room/signal re-validates the rtc frame then relays by handle', async () => {
    const room = fakeRoom();
    await withServer(
      async ({ url }) => {
        const ok = await fetch(`${url}/room/signal`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            handle: '@bob',
            frame: { t: 'rtc-offer', sdp: 'v=0\r\no=- 1 1 IN IP4 0.0.0.0' },
          }),
        });
        expect(ok.status).toBe(200);
        expect(room.sent).toHaveLength(1);
        expect(room.sent[0]?.handle).toBe('@bob');
        expect(room.sent[0]?.frame.t).toBe('rtc-offer');

        // Smuggled keys / non-rtc t are rejected before reaching the bridge.
        const bad = await fetch(`${url}/room/signal`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ handle: '@bob', frame: { t: 'msg', id: 'x', text: 'nope', at: 1 } }),
        });
        expect(bad.status).toBe(400);
        expect(room.sent).toHaveLength(1);
      },
      { room },
    );
  });

  it('createRoomBridge tags onSignal with the sender and serves a merged mailbox', async () => {
    const bridge = createRoomBridge('den');
    let signalCb: ((from: string, frame: RtcFrame) => void) | undefined;
    const sent: Array<{ handle: string; frame: RtcFrame }> = [];
    const fakeSession = {
      hello: { handle: '@self', league: '10M', harness: 'codex' },
      members: new Map([
        ['@bob', { handle: '@bob', league: '10M', harness: 'codex' }],
        ['@cara', { handle: '@cara', league: '1B', harness: 'claude-code' }],
      ]),
      onMessage() {},
      onSignal(cb: (from: string, frame: RtcFrame) => void) {
        signalCb = cb;
      },
      sendSignal(handle: string, frame: RtcFrame) {
        sent.push({ handle, frame });
      },
      broadcast() {
        return [];
      },
    } as unknown as RoomSession;
    bridge.attach(fakeSession);

    expect(bridge.self).toBe('@self');
    expect(bridge.members.map((m) => m.handle).sort()).toEqual(['@bob', '@cara']);

    bridge.sendSignal('@bob', { t: 'rtc-offer', sdp: 'offer-sdp' });
    expect(sent).toEqual([{ handle: '@bob', frame: { t: 'rtc-offer', sdp: 'offer-sdp' } }]);

    // Two senders land in ONE merged mailbox, each tagged with `from`.
    signalCb?.('@bob', { t: 'rtc-offer', sdp: 'from-bob' });
    signalCb?.('@cara', { t: 'rtc-ice', candidate: 'cand' });
    const first = await bridge.pollSignal('@self', 10);
    expect(first).toStrictEqual({ from: '@bob', rtc: { t: 'rtc-offer', sdp: 'from-bob' } });
    const second = await bridge.pollSignal('@self', 10);
    expect(second).toStrictEqual({ from: '@cara', rtc: { t: 'rtc-ice', candidate: 'cand' } });
    expect(await bridge.pollSignal('@self', 10)).toBeNull();
  });
});
