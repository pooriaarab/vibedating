/**
 * Multi-PROCESS test harness for vibedating.
 *
 * The `*.integration.test.ts` suites exercise many peers inside ONE process
 * (they share a `createTestnet` DHT and construct peer objects directly). That
 * catches protocol bugs but NOT inter-process bugs — e.g. two real CLI processes
 * with the same handle competing for the same match, or state files clobbering
 * each other. This harness spawns real `node dist/cli.js` processes, each with
 * its own state home and identity, all pointed at one local testnet DHT, and
 * drives them over stdio.
 *
 * Two env hooks make it hermetic (see state.ts / p2p.ts):
 *   - `VIBEDATE_HOME`      → per-process state dir (own identity key + handle)
 *   - `VIBEDATE_BOOTSTRAP` → "host:port,host:port" local testnet (never public DHT)
 *
 * Scenario suites live in `*.harness.test.ts` and are excluded from the fast
 * unit run (they spawn processes and take seconds). Build first: `npm run build`.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import createTestnet from 'hyperdht/testnet.js';
import type { UsageSnapshot } from '@pooriaarab/vibe-core';
import { LEAGUES } from './index.js';
import { connectProfile, grantLiveConsent } from './state.js';

/**
 * Absolute path to the BUILT CLI the harness spawns. Resolved from the repo root
 * (`dist/cli.js`), not module-relative: harness suites run under vitest where
 * this module is still `src/harness.ts`, so a module-relative path would point at
 * the nonexistent `src/cli.js`. Run `npm run build` before harness tests.
 * Override with `VIBEDATE_CLI_ENTRY` if the build output lives elsewhere.
 */
const CLI_ENTRY =
  process.env['VIBEDATE_CLI_ENTRY'] ?? path.resolve(process.cwd(), 'dist/cli.js');

/**
 * A representative lifetime-token count that lands in each league bucket, so a
 * scenario can say `seedHome({ league: '10M' })` without knowing the thresholds.
 */
export const LEAGUE_TOKENS: Readonly<Record<string, number>> = Object.fromEntries(
  LEAGUES.map((l) => [l.name, l.min]),
);

/** A running local testnet DHT + the env string spawned peers bootstrap from. */
export interface Testnet {
  readonly bootstrap: ReadonlyArray<{ readonly host: string; readonly port: number }>;
  /** Value for `VIBEDATE_BOOTSTRAP` — "host:port,host:port". */
  readonly bootstrapEnv: string;
  destroy(): Promise<void>;
}

/** Spin up an in-process testnet DHT for the spawned peers to discover each other on. */
export async function launchTestnet(size = 4): Promise<Testnet> {
  const net = await createTestnet(size);
  const bootstrap = net.bootstrap as ReadonlyArray<{ host: string; port: number }>;
  return {
    bootstrap,
    bootstrapEnv: bootstrap.map((n) => `${n.host}:${n.port}`).join(','),
    destroy: () => net.destroy(),
  };
}

/** Create a fresh, isolated state home for one peer and return its path. */
export function mkHome(): string {
  return mkdtempSync(path.join(tmpdir(), 'vd-peer-'));
}

/**
 * Seed a peer's state home so it can join `live` immediately: writes a profile
 * in the requested league and grants both share + live consent. Without this a
 * spawned peer would sit at the consent gate and never announce.
 */
export function seedHome(opts: {
  home: string;
  handle: string;
  /** League to land in (e.g. '10M'); ignored when `totalTokens` is given. */
  league?: string;
  /** Exact lifetime tokens; overrides `league`. Defaults to the '10M' band. */
  totalTokens?: number;
  harness?: string;
  verified?: boolean;
}): void {
  const tokens =
    opts.totalTokens ?? LEAGUE_TOKENS[opts.league ?? '10M'] ?? LEAGUE_TOKENS['10M']!;
  const snapshot = {
    totalTokens: tokens,
    harness: opts.harness ?? 'claude-code',
    verified: opts.verified ?? false,
  } as UsageSnapshot;
  connectProfile(snapshot, opts.handle, opts.home);
  grantLiveConsent(opts.home);
}

/** A spawned CLI peer process with helpers to observe and drive it over stdio. */
export interface SpawnedPeer {
  readonly proc: ChildProcessWithoutNullStreams;
  readonly home: string;
  readonly handle: string;
  /** All stdout+stderr captured so far. */
  text(): string;
  /** Resolve once `pattern` appears in the output, or reject after `timeoutMs`. */
  waitFor(pattern: RegExp, timeoutMs?: number): Promise<string>;
  /** Write one line to the peer's stdin (e.g. a chat message or `/open @x`). */
  send(line: string): void;
  /** SIGTERM the peer and resolve once it exits. */
  close(): Promise<void>;
}

/**
 * Spawn one real CLI peer. `command` + `args` are the vibedating subcommand and
 * flags (e.g. `'live', ['--any', '--keep-alive']`). The peer runs with its own
 * `VIBEDATE_HOME`, handle, and the testnet bootstrap — a genuine separate process.
 */
export function spawnPeer(opts: {
  home: string;
  handle: string;
  bootstrapEnv: string;
  command: string;
  args?: readonly string[];
}): SpawnedPeer {
  const proc = spawn('node', [CLI_ENTRY, opts.command, ...(opts.args ?? [])], {
    env: {
      ...process.env,
      VIBEDATE_HOME: opts.home,
      VIBEDATING_HANDLE: opts.handle,
      VIBEDATE_BOOTSTRAP: opts.bootstrapEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;

  return buildSpawnedPeer(proc, opts);
}

/**
 * Build the SpawnedPeer object returned by {@link spawnPeer}.
 * Module-private; extracted to keep spawnPeer under the line budget.
 */
function buildSpawnedPeer(
  proc: ChildProcessWithoutNullStreams,
  opts: {
    home: string;
    handle: string;
  },
): SpawnedPeer {
  let buffer = '';
  const waiters: Array<{ re: RegExp; resolve: (m: string) => void }> = [];
  const onChunk = (chunk: Buffer): void => {
    buffer += chunk.toString('utf8');
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.re.test(buffer)) {
        waiters[i]!.resolve(buffer);
        waiters.splice(i, 1);
      }
    }
  };
  proc.stdout.on('data', onChunk);
  proc.stderr.on('data', onChunk);

  return makeSpawnedHandlers(proc, opts, buffer, waiters);
}

/**
 * Build the { text, waitFor, send, close } methods for the SpawnedPeer.
 * Extracted so its size doesn't count toward buildSpawnedPeer's line budget.
 */
function makeSpawnedHandlers(
  proc: ChildProcessWithoutNullStreams,
  opts: {
    home: string;
    handle: string;
  },
  buffer: string,
  waiters: Array<{ re: RegExp; resolve: (m: string) => void }>,
): SpawnedPeer {
  return {
    proc,
    home: opts.home,
    handle: opts.handle,
    text: () => buffer,
    waitFor: (pattern, timeoutMs = 30_000) =>
      new Promise<string>((resolve, reject) => {
        if (pattern.test(buffer)) return resolve(buffer);
        const timer = setTimeout(() => {
          const idx = waiters.findIndex((w) => w.re === pattern);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(
            new Error(
              `[${opts.handle}] timed out after ${timeoutMs}ms waiting for ${pattern}\n--- output ---\n${buffer}`,
            ),
          );
        }, timeoutMs);
        waiters.push({
          re: pattern,
          resolve: (m) => {
            clearTimeout(timer);
            resolve(m);
          },
        });
      }),
    send: (line) => proc.stdin.write(line.endsWith('\n') ? line : `${line}\n`),
    close: () =>
      new Promise<void>((resolve) => {
        if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
        // SIGTERM first; SIGKILL if it hasn't exited in 3s so a peer wedged in
        // the swarm can never hang the suite's teardown.
        const kill9 = setTimeout(() => proc.kill('SIGKILL'), 3_000);
        proc.once('exit', () => {
          clearTimeout(kill9);
          resolve();
        });
        proc.kill('SIGTERM');
      }),
  };
}
