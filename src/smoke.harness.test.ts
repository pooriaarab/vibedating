/**
 * Foundation smoke test for the multi-PROCESS harness (see harness.ts).
 *
 * Two real CLI processes, distinct homes + identities, one local testnet: they
 * must discover + match each other and pass a chat message across the process
 * boundary. If this fails, the harness base is broken and no scenario suite
 * built on it can be trusted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchTestnet, mkHome, seedHome, spawnPeer, type SpawnedPeer, type Testnet } from './harness.js';

describe('multi-process harness — two real CLI peers match + chat', () => {
  let net: Testnet;
  const peers: SpawnedPeer[] = [];

  beforeAll(async () => {
    net = await launchTestnet(4);
  }, 60_000);

  afterAll(async () => {
    await Promise.all(peers.map((p) => p.close()));
    await net.destroy();
  }, 30_000);

  it('mac and lenovo discover each other and a message crosses the process boundary', async () => {
    const macHome = mkHome();
    const lenovoHome = mkHome();
    seedHome({ home: macHome, handle: '@mac', league: '10M' });
    seedHome({ home: lenovoHome, handle: '@lenovo', league: '10M' });

    const mac = spawnPeer({
      home: macHome,
      handle: '@mac',
      bootstrapEnv: net.bootstrapEnv,
      command: 'live',
      args: ['--any', '--keep-alive'],
    });
    const lenovo = spawnPeer({
      home: lenovoHome,
      handle: '@lenovo',
      bootstrapEnv: net.bootstrapEnv,
      command: 'live',
      args: ['--any', '--keep-alive'],
    });
    peers.push(mac, lenovo);

    // Both sides must actually pair (not just announce).
    await mac.waitFor(/matched @lenovo/, 40_000);
    await lenovo.waitFor(/matched @mac/, 40_000);

    // A message from mac must render on lenovo — the cross-process delivery the
    // in-process suites can't prove.
    mac.send('hello from mac');
    const seen = await lenovo.waitFor(/<@mac> hello from mac/, 20_000);
    expect(seen).toMatch(/<@mac> hello from mac/);
  }, 80_000);
});
