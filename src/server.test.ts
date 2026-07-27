import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { VibeEvent } from '@pooriaarab/vibe-core';
import { CANDIDATES } from './index.js';
import { startServer, type StartedServer, type StartServerOptions } from './server.js';

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
