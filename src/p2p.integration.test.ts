/**
 * Integration test: TWO real hyperswarm nodes in one process, on an isolated
 * in-process DHT (hyperdht's createTestnet — the public DHT is never touched).
 * They discover each other via a shared random topic, run the handshake both
 * ways, and each must end up with the other's { handle, league } in its peer
 * set (and in its peers.json). A mismatch-league impostor must be dropped.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import createTestnet from 'hyperdht/testnet.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { VibeEvent } from '@pooriaarab/vibe-core';
import {
  loadPeers,
  randomTopic,
  startDiscovery,
  type DiscoverySession,
  type PeerHello,
} from './p2p.js';

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

function hasPeer(session: DiscoverySession, hello: PeerHello): boolean {
  return [...session.peers.values()].some(
    (p) => p.handle === hello.handle && p.league === hello.league,
  );
}

describe('live P2P discovery (in-process DHT, no public network)', () => {
  let testnet: Awaited<ReturnType<typeof createTestnet>>;
  let dirs: string[];
  let sessions: DiscoverySession[];

  beforeEach(async () => {
    testnet = await createTestnet(3);
    dirs = [];
    sessions = [];
  }, 30_000);

  afterEach(async () => {
    for (const s of sessions) await s.close();
    await testnet.destroy();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }, 30_000);

  function tmpDir(): string {
    const d = mkdtempSync(path.join(os.tmpdir(), 'vibedating-p2p-'));
    dirs.push(d);
    return d;
  }

  async function spawn(hello: PeerHello, topic: Buffer, sink?: (e: VibeEvent) => void) {
    const session = await startDiscovery({
      hello,
      topic,
      bootstrap: testnet.bootstrap,
      stateDir: tmpDir(),
      ...(sink === undefined ? {} : { notify: sink }),
    });
    sessions.push(session);
    return session;
  }

  it('two nodes on a shared topic exchange hellos both ways', async () => {
    const topic = randomTopic();
    const eventsA: VibeEvent[] = [];
    const eventsB: VibeEvent[] = [];

    const a = await spawn(ALICE, topic, (e) => eventsA.push(e));
    const b = await spawn(BOB, topic, (e) => eventsB.push(e));
    await Promise.all([a.ready, b.ready]);

    const found = await waitFor(() => hasPeer(a, BOB) && hasPeer(b, ALICE), 15_000);
    expect(found).toBe(true);

    // Each peer set holds the other's { handle, league } (and harness).
    expect([...a.peers.values()]).toContainEqual(BOB);
    expect([...b.peers.values()]).toContainEqual(ALICE);

    // …and only allowlisted fields ever made it into the peer set.
    for (const p of [...a.peers.values(), ...b.peers.values()]) {
      expect(Object.keys(p).sort()).toEqual(['handle', 'harness', 'league']);
    }

    // New mutual same-league peer → exactly one 'match' notification per side.
    expect(eventsA.filter((e) => e.kind === 'match')).toHaveLength(1);
    expect(eventsB.filter((e) => e.kind === 'match')).toHaveLength(1);
    expect(eventsA[0]?.payload?.['handle']).toBe('@bob_10M');
    expect(eventsB[0]?.payload?.['handle']).toBe('@alice_10M');

    // Both sides persisted the other to their own peers.json.
    // (sessions were spawned in order: a → dirs[0], b → dirs[1])
    expect(loadPeers(dirs[0]!).map((p) => p.handle)).toContain('@bob_10M');
    expect(loadPeers(dirs[1]!).map((p) => p.handle)).toContain('@alice_10M');
  }, 30_000);

  it('drops a peer advertising a different league on the topic', async () => {
    const topic = randomTopic();
    const a = await spawn(ALICE, topic);

    // A raw impostor (not via startDiscovery): joins the same topic and pushes
    // a hostile hello — wrong league plus raw-usage fields — on every connection.
    const { default: Hyperswarm } = await import('hyperswarm');
    const mallory = new Hyperswarm({ bootstrap: testnet.bootstrap });
    let aliceHelloSeen = '';
    mallory.on('connection', (socket) => {
      socket.write(
        JSON.stringify({
          handle: '@mallory_1B',
          league: '1B+',
          harness: 'codex',
          totalTokens: 999_000_000,
          rawUsage: { everything: true },
        }) + '\n',
      );
      socket.on('data', (chunk: Buffer) => {
        aliceHelloSeen += chunk.toString('utf8');
      });
      socket.on('error', () => {});
    });
    const discovery = mallory.join(topic, { server: true, client: true });
    // A raw swarm re-refreshes a topic only every ~10 minutes, and its first
    // round can legitimately miss/error under load — re-run rounds eagerly so
    // this test isn't hostage to one racy lookup. (startDiscovery nodes await
    // their first round, so they don't need this.)
    const retry = setInterval(() => {
      void discovery.refresh({ server: true, client: true }).catch(() => {});
    }, 1000);

    try {
      // Connection + one-way handshake definitely happened…
      const connected = await waitFor(() => aliceHelloSeen.includes('@alice_10M'), 20_000);
      expect(connected).toBe(true);
      // …but ALICE's session must drop the mismatched-league hello entirely.
      await new Promise((r) => setTimeout(r, 1000)); // let any (non-)processing settle
      expect(a.peers.size).toBe(0);
      expect(loadPeers(dirs[0]!)).toEqual([]);
    } finally {
      clearInterval(retry);
      await mallory.destroy();
    }
  }, 30_000);
});
