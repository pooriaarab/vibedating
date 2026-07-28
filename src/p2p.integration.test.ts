/**
 * Integration test: TWO real hyperswarm nodes in one process, on an isolated
 * in-process DHT (hyperdht's createTestnet — the public DHT is never touched).
 * They discover each other via a shared random topic, run the handshake both
 * ways, and each must end up with the other's { handle, league } in its peer
 * set (and in its peers.json). A mismatched-league impostor must be dropped.
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
import { serializeFrame } from './frame.js';
import { loadOrCreateIdentity, signHelloClaims } from './identity.js';
import { sameHandle } from './state.js';

const ALICE: PeerHello = { handle: '@alice_10M', league: '10M', harness: 'claude-code' };
const BOB: PeerHello = { handle: '@bob_10M', league: '10M', harness: 'codex' };
const CAROL: PeerHello = { handle: '@carol_10M', league: '10M', harness: 'cursor' };

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
    // Same rule as startDiscovery: no announce/lookup before the node has routes.
    await mallory.dht.fullyBootstrapped();
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
    // this test isn't hostage to one racy lookup. (startDiscovery sessions do
    // this internally; mallory is a bare Hyperswarm, so it happens here.)
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

  it('find flags exactly the target handle among several peers (sameHandle filter)', async () => {
    // Mirrors `vibedate find <@handle>`: ALICE is the finder, BOB is the target,
    // CAROL is a same-league decoy. ALICE's onPeer records every peer and flags
    // the one whose handle matches the target (★) — the decoy is seen but never
    // flagged.
    const topic = randomTopic();
    const target = BOB.handle; // '@bob_10M'
    const seen = new Set<string>();

    const alice = await startDiscovery({
      hello: ALICE,
      topic,
      bootstrap: testnet.bootstrap,
      stateDir: tmpDir(),
      onPeer: (peer) => {
        seen.add(peer.handle);
        if (sameHandle(peer.handle, target)) seen.add('★' + peer.handle);
      },
    });
    sessions.push(alice);
    const bob = await spawn(BOB, topic);
    const carol = await spawn(CAROL, topic);
    await Promise.all([alice.ready, bob.ready, carol.ready]);

    const ok = await waitFor(
      () => seen.has(BOB.handle) && seen.has(CAROL.handle) && seen.has('★' + BOB.handle),
      20_000,
    );
    expect(ok).toBe(true);
    // The decoy was discovered but NOT flagged as the target.
    expect(seen.has('★' + CAROL.handle)).toBe(false);
  }, 30_000);

  it('drops a blocked peer (isBlocked) exactly like a wrong-league one', async () => {
    // ALICE blocks BOB's handle via the injected isBlocked predicate. A raw
    // impostor (not via startDiscovery) plays BOB: joins the topic and pushes
    // BOB's hello as a typed frame on every connection. The connection still
    // happens (BOB sees ALICE's hello), but ALICE drops BOB's hello on arrival —
    // never recorded to peers.json, never notified, never passed to onPeer.
    // (Mirrors the proven wrong-league impostor test above, with isBlocked.)
    const topic = randomTopic();
    let onPeerFired = false;
    const aliceDir = tmpDir();
    const alice = await startDiscovery({
      hello: ALICE,
      topic,
      bootstrap: testnet.bootstrap,
      stateDir: aliceDir,
      isBlocked: (h) => sameHandle(h, BOB.handle),
      onPeer: () => {
        onPeerFired = true;
      },
    });
    sessions.push(alice);

    const { default: Hyperswarm } = await import('hyperswarm');
    const bobRaw = new Hyperswarm({ bootstrap: testnet.bootstrap });
    await bobRaw.dht.fullyBootstrapped();
    let aliceHelloSeen = '';
    bobRaw.on('connection', (socket) => {
      socket.write(
        serializeFrame({
          t: 'hello',
          handle: BOB.handle,
          league: BOB.league,
          harness: BOB.harness,
        }) + '\n',
      );
      socket.on('data', (chunk: Buffer) => {
        aliceHelloSeen += chunk.toString('utf8');
      });
      socket.on('error', () => {});
    });
    const discovery = bobRaw.join(topic, { server: true, client: true });
    // A bare swarm refreshes a topic only every ~10 min and its first round can
    // miss/error under load — re-run rounds eagerly (startDiscovery does this
    // internally; the raw impostor does not).
    const retry = setInterval(() => {
      void discovery.refresh({ server: true, client: true }).catch(() => {});
    }, 1000);

    try {
      // The connection + one-way handshake definitely happened (BOB saw ALICE).
      const connected = await waitFor(() => aliceHelloSeen.includes(ALICE.handle), 20_000);
      expect(connected).toBe(true);
      // …but ALICE blocked BOB, so BOB is dropped entirely.
      await new Promise((r) => setTimeout(r, 1000)); // let any (non-)processing settle
      expect([...alice.peers.values()]).toEqual([]);
      expect(onPeerFired).toBe(false);
      expect(loadPeers(aliceDir).map((p) => p.handle)).not.toContain(BOB.handle);
    } finally {
      clearInterval(retry);
      await bobRaw.destroy();
    }
  }, 30_000);

  it('two signed peers mark each other identity-verified and persist the pubkey', async () => {
    // Both sides sign their hello with a persistent ed25519 identity (generated
    // into their own state dirs, exactly like the CLI does). Each must end up
    // with the other's pubkey retained + identityVerified — and NO nonce/sig.
    const topic = randomTopic();
    const dirA = tmpDir();
    const dirB = tmpDir();
    const idA = loadOrCreateIdentity(dirA);
    const idB = loadOrCreateIdentity(dirB);
    const claimsA = { handle: '@alice_10M', league: '10M', harness: 'claude-code', verified: true };
    const claimsB = { handle: '@bob_10M', league: '10M', harness: 'codex', verified: false };
    const helloA: PeerHello = { ...claimsA, ...signHelloClaims(idA, claimsA) };
    const helloB: PeerHello = { ...claimsB, ...signHelloClaims(idB, claimsB) };

    const a = await startDiscovery({ hello: helloA, topic, bootstrap: testnet.bootstrap, stateDir: dirA });
    sessions.push(a);
    const b = await startDiscovery({ hello: helloB, topic, bootstrap: testnet.bootstrap, stateDir: dirB });
    sessions.push(b);
    await Promise.all([a.ready, b.ready]);

    const found = await waitFor(() => hasPeer(a, helloB) && hasPeer(b, helloA), 40_000);
    expect(found).toBe(true);

    const peerB = [...a.peers.values()].find((p) => p.handle === helloB.handle)!;
    expect(peerB.identityVerified).toBe(true);
    expect(peerB.pubkey).toBe(idB.publicKeyHex);
    expect(peerB.verified).toBe(false); // the signed verified flag travels as-is
    expect(peerB).not.toHaveProperty('sig');
    expect(peerB).not.toHaveProperty('nonce');

    const peerA = [...b.peers.values()].find((p) => p.handle === helloA.handle)!;
    expect(peerA.identityVerified).toBe(true);
    expect(peerA.pubkey).toBe(idA.publicKeyHex);
    expect(peerA.verified).toBe(true);

    // Persisted to peers.json too (pubkey + identityVerified, still no proof material).
    const storedB = loadPeers(dirA).find((p) => p.handle === helloB.handle)!;
    expect(storedB.pubkey).toBe(idB.publicKeyHex);
    expect(storedB.identityVerified).toBe(true);
    expect(storedB).not.toHaveProperty('sig');
  }, 60_000);

  it('drops a peer whose hello signature does not verify (impersonation attempt)', async () => {
    // A raw impostor pushes a well-formed but INVALID proof: 64-hex pubkey +
    // 128-hex sig that was never signed by that key. Connection + one-way
    // handshake happen, but ALICE must drop the peer entirely.
    const topic = randomTopic();
    const aliceDir = tmpDir();
    let onPeerFired = false;
    const alice = await startDiscovery({
      hello: ALICE,
      topic,
      bootstrap: testnet.bootstrap,
      stateDir: aliceDir,
      onPeer: () => {
        onPeerFired = true;
      },
    });
    sessions.push(alice);

    const { default: Hyperswarm } = await import('hyperswarm');
    const mallory = new Hyperswarm({ bootstrap: testnet.bootstrap });
    await mallory.dht.fullyBootstrapped();
    let aliceHelloSeen = '';
    mallory.on('connection', (socket) => {
      socket.write(
        serializeFrame({
          t: 'hello',
          handle: '@mallory_10M',
          league: '10M',
          harness: 'codex',
          verified: true,
          pubkey: 'ab'.repeat(32), // well-formed 64-hex
          nonce: 'cd'.repeat(16),
          sig: 'ef'.repeat(64), // well-formed 128-hex, never signed by that key
        }) + '\n',
      );
      socket.on('data', (chunk: Buffer) => {
        aliceHelloSeen += chunk.toString('utf8');
      });
      socket.on('error', () => {});
    });
    const discovery = mallory.join(topic, { server: true, client: true });
    // Bare swarms refresh slowly and first rounds can miss — retry eagerly
    // (same pattern as the other impostor tests above).
    const retry = setInterval(() => {
      void discovery.refresh({ server: true, client: true }).catch(() => {});
    }, 1000);

    try {
      const connected = await waitFor(() => aliceHelloSeen.includes('@alice_10M'), 20_000);
      expect(connected).toBe(true);
      // …but the signature doesn't verify → dropped: never retained, never
      // surfaced to onPeer, never persisted.
      await new Promise((r) => setTimeout(r, 1000)); // let any (non-)processing settle
      expect([...alice.peers.values()]).toEqual([]);
      expect(onPeerFired).toBe(false);
      expect(loadPeers(aliceDir)).toEqual([]);
    } finally {
      clearInterval(retry);
      await mallory.destroy();
    }
  }, 30_000);
});
