/**
 * Live-session integration test: TWO real hyperswarm nodes on an isolated
 * in-process DHT (hyperdht's createTestnet — the public DHT is never touched).
 *
 * Where `p2p.integration.test.ts` proves the one-shot hello handshake, this
 * proves the LIVE layer that sits on top: each connection surfaces a PeerLink,
 * the two nodes exchange text frames BOTH ways, and an omegle-style "next"
 * (linkA.close()) makes the remote peer see onClose. This is the multi-machine
 * proof for increment 1 — no unit test can substitute for it.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import createTestnet from 'hyperdht/testnet.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  randomTopic,
  startDiscovery,
  type DiscoverySession,
  type PeerHello,
} from './p2p.js';
import type { PeerLink } from './link.js';

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

describe('live session (in-process DHT, no public network)', () => {
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
    const d = mkdtempSync(path.join(os.tmpdir(), 'vibedating-live-'));
    dirs.push(d);
    return d;
  }

  /** spawn + onLink: a discovery node that also captures each live PeerLink. */
  async function spawnWithLink(
    hello: PeerHello,
    topic: Buffer,
    onLink: (link: PeerLink) => void,
  ): Promise<DiscoverySession> {
    const session = await startDiscovery({
      hello,
      topic,
      bootstrap: testnet.bootstrap,
      stateDir: tmpDir(),
      onLink,
    });
    sessions.push(session);
    return session;
  }

  it('two machines chat both ways, then next closes the link', async () => {
    const topic = randomTopic();
    let linkA: PeerLink | undefined;
    let linkB: PeerLink | undefined;
    const gotA: string[] = [];
    const gotB: string[] = [];
    const a = await spawnWithLink(ALICE, topic, (l) => {
      linkA = l;
      l.onMessage((m) => gotA.push(m.text));
    });
    const b = await spawnWithLink(BOB, topic, (l) => {
      linkB = l;
      l.onMessage((m) => gotB.push(m.text));
    });
    await Promise.all([a.ready, b.ready]);

    // Both links must exist (each side handshook with the other).
    expect(await waitFor(() => !!linkA && !!linkB, 15_000)).toBe(true);

    // Text flows both ways over the live links.
    linkA!.send('hey bob');
    linkB!.send('hey alice');
    expect(await waitFor(() => gotB.includes('hey bob') && gotA.includes('hey alice'), 10_000)).toBe(
      true,
    );

    // Omegle "next": A hangs up → B's link onClose fires (via the bye frame).
    let bClosed = false;
    linkB!.onClose(() => {
      bClosed = true;
    });
    linkA!.close();
    expect(await waitFor(() => bClosed, 10_000)).toBe(true);
  }, 45_000);
});
