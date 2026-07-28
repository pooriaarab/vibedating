/**
 * Room integration test: THREE real hyperswarm nodes on an isolated in-process
 * DHT (hyperdht's createTestnet — the public DHT is never touched).
 *
 * Proves the GROUP layer that sits on top of 1:1 discovery:
 *   - all three members discover each other and end up with a 2-member roster
 *     (rooms are multi-peer, NOT 1:1 pairings);
 *   - one member's broadcast reaches BOTH others (fan-out over each PeerLink),
 *     each tagged with the sender's handle.
 *
 * Mirrors the live.integration.test.ts harness; rooms are consent-gated +
 * reuse startDiscovery/PeerLink exactly like the 1:1 path (only the topic +
 * acceptLeague differ), so this is the multi-machine proof for the room model.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import createTestnet from 'hyperdht/testnet.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startRoom, type RoomSession } from './room.js';
import type { PeerHello } from './p2p.js';

// Distinct handles + a cross-league member (rooms accept every league) so the
// roster + broadcast proofs are not confused by the 1:1 self-filter.
const ALICE: PeerHello = { handle: '@alice_room', league: '10M', harness: 'claude-code' };
const BOB: PeerHello = { handle: '@bob_room', league: '10M', harness: 'codex' };
const CAROL: PeerHello = { handle: '@carol_room', league: '5M', harness: 'cursor' };

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return cond();
}

describe('room discovery (in-process DHT, no public network)', () => {
  let testnet: Awaited<ReturnType<typeof createTestnet>>;
  let dirs: string[];
  let rooms: RoomSession[];

  beforeEach(async () => {
    testnet = await createTestnet(3);
    dirs = [];
    rooms = [];
  }, 30_000);

  afterEach(async () => {
    for (const r of rooms) await r.close();
    await testnet.destroy();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }, 30_000);

  function tmpDir(): string {
    const d = mkdtempSync(path.join(os.tmpdir(), 'vibedating-room-'));
    dirs.push(d);
    return d;
  }

  async function spawn(hello: PeerHello, room: string): Promise<RoomSession> {
    const r = await startRoom({
      hello,
      room,
      bootstrap: testnet.bootstrap,
      stateDir: tmpDir(),
    });
    rooms.push(r);
    return r;
  }

  it('three members on one room all see each other in the roster', async () => {
    // A unique room name per run so parallel test runs never collide.
    const room = 'den-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const a = await spawn(ALICE, room);
    const b = await spawn(BOB, room);
    const c = await spawn(CAROL, room);
    await Promise.all([a.ready, b.ready, c.ready]);

    // Each member must end up with exactly the OTHER two in its roster.
    const allFull = await waitFor(
      () => a.members.size === 2 && b.members.size === 2 && c.members.size === 2,
      30_000,
    );
    expect(allFull).toBe(true);

    expect([...a.members.keys()].sort()).toEqual([BOB.handle, CAROL.handle].sort());
    expect([...b.members.keys()].sort()).toEqual([ALICE.handle, CAROL.handle].sort());
    expect([...c.members.keys()].sort()).toEqual([ALICE.handle, BOB.handle].sort());

    // The cross-league member (CAROL is 5M; the others 10M) is still a member —
    // rooms are intentionally cross-league.
    expect([...a.members.values()].map((m) => m.league)).toContain('5M');
  }, 45_000);

  it('a broadcast reaches every other member (fan-out), tagged with the sender', async () => {
    const room = 'lounge-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const gotB: { from: string; text: string }[] = [];
    const gotC: { from: string; text: string }[] = [];

    const a = await spawn(ALICE, room);
    const b = await spawn(BOB, room);
    b.onMessage((m) => gotB.push({ from: m.from, text: m.text }));
    const c = await spawn(CAROL, room);
    c.onMessage((m) => gotC.push({ from: m.from, text: m.text }));
    await Promise.all([a.ready, b.ready, c.ready]);

    // Wait until A sees both peers before broadcasting (so the fan-out has live
    // links to send over).
    expect(await waitFor(() => a.members.size === 2, 30_000)).toBe(true);

    const reached = a.broadcast('hello room');
    expect([...reached].sort()).toEqual([BOB.handle, CAROL.handle].sort());

    expect(await waitFor(() => gotB.length === 1 && gotC.length === 1, 15_000)).toBe(true);
    expect(gotB[0]).toEqual({ from: ALICE.handle, text: 'hello room' });
    expect(gotC[0]).toEqual({ from: ALICE.handle, text: 'hello room' });
  }, 45_000);
});
