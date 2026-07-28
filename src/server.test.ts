import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { VibeEvent } from '@pooriaarab/vibe-core';
import { CANDIDATES } from './index.js';
import type { RtcFrame } from './frame.js';
import {
  createLiveBridge,
  startServer,
  type LiveBridge,
  type LivePeerInfo,
  type StartedServer,
  type StartServerOptions,
} from './server.js';
import type { PeerLink } from './link.js';

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
  /** A fake LiveBridge that records what the server tries to send and lets a
   *  test pre-queue frames for the long-poll to return. */
  function fakeBridge(seedPeers: readonly LivePeerInfo[] = []): LiveBridge & {
    sent: Array<{ handle: string; frame: RtcFrame }>;
    queue: Map<string, RtcFrame[]>;
  } {
    const sent: Array<{ handle: string; frame: RtcFrame }> = [];
    const queue = new Map<string, RtcFrame[]>();
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
      sent,
      queue,
    };
  }

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
