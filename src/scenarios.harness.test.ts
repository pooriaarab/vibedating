/**
 * Multi-peer scenario suite over the multi-PROCESS harness (see harness.ts).
 *
 * These spawn several real CLI processes on a per-test local testnet and drive
 * them over stdio to shake out ORCHESTRATION bugs that only appear with real
 * peers in separate processes — specifically the friend-reported "a queued
 * (non-current) peer's message is silently dropped" bug: here two peers both
 * target one hub, the hub pairs one and queues the other, and the queued peer's
 * message must be buffered and flushed verbatim on /open, never lost.
 *
 * (The queue/buffer logic is also unit-tested deterministically at any N in
 * pairing.test.ts; cross-league `--any` scoping in live.integration.test.ts.
 * This suite proves the property holds across real process boundaries.)
 *
 * Real processes + real DHT ⇒ generous timeouts. Run: `npm run test:harness`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  launchTestnet,
  mkHome,
  seedHome,
  spawnPeer,
  type SpawnedPeer,
  type Testnet,
} from './harness.js';

// Each test gets its OWN fresh testnet + clean process set: real-DHT routing
// state accumulates across a heavy multi-process run, so a shared net makes later
// tests flaky. Per-test isolation trades a little startup time for reliability.
describe('multi-peer scenarios (real processes, per-test testnet)', () => {
  let net: Testnet;
  let spawned: SpawnedPeer[] = [];

  beforeEach(async () => {
    net = await launchTestnet(10);
  }, 60_000);

  afterEach(async () => {
    await Promise.all(spawned.map((p) => p.close()));
    spawned = [];
    await net.destroy();
  }, 40_000);

  /** Spawn a `live` peer in a given league, tracked for teardown. */
  function live(handle: string, league: string, args: readonly string[] = ['--any', '--keep-alive']): SpawnedPeer {
    const home = mkHome();
    seedHome({ home, handle, league });
    const p = spawnPeer({ home, handle, bootstrapEnv: net.bootstrapEnv, command: 'live', args });
    spawned.push(p);
    return p;
  }

  // ── Focused buffering: a non-current peer's message buffers + flushes ─────
  // hub matches one peer; the OTHER (queued) peer's message must be buffered and
  // then flushed verbatim on /open — the exact path that used to drop it.
  it('a queued (non-current) peer\'s message is buffered + flushed on open, never dropped', async () => {
    const hub = live('@hub', '10M', ['--any', '--keep-alive']);
    const alice = live('@alice', '10M', ['--to', '@hub', '--keep-alive']);
    const bob = live('@bob', '10M', ['--to', '@hub', '--keep-alive']);

    // BOTH peers must connect to the hub before either sends, else a message
    // posts into the void (no link yet) and never queues. Wait for each peer's
    // own connect confirmation AND for the hub to have paired one of them.
    await Promise.all([
      alice.waitFor(/found @hub|matched @hub/, 70_000),
      bob.waitFor(/found @hub|matched @hub/, 70_000),
    ]);
    await hub.waitFor(/· matched @(alice|bob)/, 60_000);
    alice.send('queued-hello-alice');
    bob.send('queued-hello-bob');

    // A queued-message notification must appear, naming whichever peer is queued.
    const queuedLine = await hub.waitFor(/@(alice|bob) sent a message \(\d+ queued\)/, 45_000);
    const queuedPeer = /@alice sent a message/.test(queuedLine) ? 'alice' : 'bob';

    // Opening the queued peer flushes its buffered message verbatim — no loss.
    hub.send(`/open @${queuedPeer}`);
    await hub.waitFor(new RegExp(`queued-hello-${queuedPeer}`), 40_000);
    expect(hub.text()).toMatch(new RegExp(`<@${queuedPeer}> queued-hello-${queuedPeer}`));
    expect(bob).toBeDefined();
    expect(alice).toBeDefined();
  }, 150_000);
});
