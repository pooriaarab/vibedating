import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, type StartedServer } from './server.js';

// Hermetic state dir so the test never touches ~/.vibedating.
const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'vibedating-test-'));
afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

async function withServer(fn: (s: StartedServer) => Promise<void>): Promise<void> {
  const s = await startServer({ port: 0, dir: tmpDir });
  try {
    await fn(s);
  } finally {
    await new Promise<void>((resolve) => s.server.close(() => resolve()));
  }
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
