import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Multi-PROCESS harness suites (*.harness.test.ts) spawn the BUILT CLI
    // (dist/cli.js). They are skipped by `npm test` via a CLI --exclude (CI may
    // run before a build) and run explicitly via `npm run test:harness`, which
    // builds first. The exclude lives in the script, NOT here, so test:harness
    // can still target them.
    //
    // The hyperswarm integration test drives real UDP sockets via udx-native,
    // which misbehave inside worker_threads — run those files as child processes.
    poolMatchGlobs: [
      ['**/p2p.integration.test.ts', 'forks'],
      ['**/live.integration.test.ts', 'forks'],
      ['**/media.integration.test.ts', 'forks'],
      ['**/signal.integration.test.ts', 'forks'],
      ['**/webrtc.integration.test.ts', 'forks'],
      ['**/room.integration.test.ts', 'forks'],
      ['**/*.harness.test.ts', 'forks'],
    ],
  },
});
