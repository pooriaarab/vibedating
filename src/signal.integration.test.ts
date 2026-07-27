/**
 * WebRTC-signaling integration test: TWO real hyperswarm nodes on an isolated
 * in-process DHT (hyperdht's createTestnet — the public DHT is never touched).
 *
 * No real media flows here — the browser's RTCPeerConnection is intentionally
 * out of scope for the testable core. What this proves is that the signaling
 * RELAY works end-to-end across real machines: each side's PeerLink.sendSignal
 * emits an rtc-* frame that the remote's PeerLink.onSignal receives INTACT and
 * ALLOWLISTED (only the keys the protocol permits — {t,sdp} / {t,candidate} —
 * ever surface; a peer cannot smuggle extra fields onto the wire). This is the
 * multi-machine proof for increment 2b; no unit test (which fakes the socket)
 * can substitute for it.
 *
 * The deeper "extra keys are STRIPPED on receipt" property is asserted at two
 * cheaper layers too: frame.test.ts (parseFrame drops unknown keys) and
 * link.test.ts (a forged line carrying a leak, pushed through a cross-wired
 * socket, arrives at onSignal already sanitized). Together the three layers
 * close the loop without needing to forge bytes onto a live hyperswarm socket
 * (PeerLink.sendSignal's own type forbids smuggled keys — by design).
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
import type { RtcFrame } from './frame.js';
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

describe('rtc signaling relay (in-process DHT, no public network)', () => {
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
    const d = mkdtempSync(path.join(os.tmpdir(), 'vibedating-signal-'));
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

  it('two machines exchange offer→answer + an ICE candidate BOTH ways, intact + allowlisted', async () => {
    const topic = randomTopic();
    let linkA: PeerLink | undefined;
    let linkB: PeerLink | undefined;
    const sigA: RtcFrame[] = []; // frames A RECEIVES (sent by B)
    const sigB: RtcFrame[] = []; // frames B RECEIVES (sent by A)

    const a = await spawnWithLink(ALICE, topic, (l) => {
      linkA = l;
      // A must register onSignal BEFORE B sends, so the listener is in place
      // when the first rtc frame arrives (mirrors the onMedia precondition).
      l.onSignal((f) => sigA.push(f));
    });
    const b = await spawnWithLink(BOB, topic, (l) => {
      linkB = l;
      l.onSignal((f) => sigB.push(f));
    });
    await Promise.all([a.ready, b.ready]);

    expect(await waitFor(() => !!linkA && !!linkB, 15_000)).toBe(true);

    // ── A is the offerer: send an offer + a trickle ICE candidate. ──────────
    linkA!.sendSignal({ t: 'rtc-offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n' });
    linkA!.sendSignal({ t: 'rtc-ice', candidate: 'candidate:1 1 udp 1 1.2.3.4 1 typ host' });
    // B must receive BOTH, intact.
    expect(await waitFor(() => sigB.length >= 2, 15_000)).toBe(true);
    expect(sigB[0]).toEqual({ t: 'rtc-offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n' });
    expect(sigB[1]).toEqual({ t: 'rtc-ice', candidate: 'candidate:1 1 udp 1 1.2.3.4 1 typ host' });

    // ── B is the answerer: reply with an answer + an ICE candidate. ─────────
    linkB!.sendSignal({ t: 'rtc-answer', sdp: 'v=0\r\no=- 2 1 IN IP4 127.0.0.1\r\n' });
    linkB!.sendSignal({ t: 'rtc-ice', candidate: 'candidate:2 1 udp 1 5.6.7.8 2 typ host' });
    expect(await waitFor(() => sigA.length >= 2, 15_000)).toBe(true);
    expect(sigA[0]).toEqual({ t: 'rtc-answer', sdp: 'v=0\r\no=- 2 1 IN IP4 127.0.0.1\r\n' });
    expect(sigA[1]).toEqual({ t: 'rtc-ice', candidate: 'candidate:2 1 udp 1 5.6.7.8 2 typ host' });

    // Allowlist: no received frame may carry any key beyond its permitted
    // shape ({t,sdp} for offer/answer, {t,candidate} for ice). A peer can never
    // surface a raw-usage / impostor field through onSignal.
    for (const f of [...sigA, ...sigB]) {
      const keys = Object.keys(f).sort();
      if (f.t === 'rtc-ice') expect(keys).toEqual(['candidate', 't']);
      else expect(keys).toEqual(['sdp', 't']);
    }
  }, 45_000);
});
