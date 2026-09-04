/**
 * Shared harness for latency benches — mirrors the createTestnet pattern used
 * by src/*.integration.test.ts (isolated in-process DHT, no public network).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import createTestnet from 'hyperdht/testnet.js';
import {
  randomTopic,
  startDiscovery,
  type DiscoverySession,
  type PeerHello,
} from '../src/p2p.js';
import type { PeerLink } from '../src/link.js';
import { startRoom, type RoomSession } from '../src/room.js';

export type Bootstrap = ReadonlyArray<{ readonly host: string; readonly port: number }>;

export interface TestnetHandle {
  readonly bootstrap: Bootstrap;
  destroy(): Promise<void>;
}

export async function createLocalTestnet(nodes = 3): Promise<TestnetHandle> {
  const testnet = await createTestnet(nodes);
  return {
    bootstrap: testnet.bootstrap,
    destroy: () => testnet.destroy(),
  };
}

export function hello(handle: string, league = '10M'): PeerHello {
  return { handle, league, harness: 'bench' };
}

export async function waitFor(
  cond: () => boolean,
  timeoutMs: number,
  pollMs = 10,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return cond();
}

export function waitForEvent(
  cond: () => boolean,
  timeoutMs: number,
  pollMs = 5,
): Promise<boolean> {
  return waitFor(cond, timeoutMs, pollMs);
}

/** Performance.now-style elapsed wall clock in ms. */
export function nowMs(): number {
  return performance.now();
}

export class TempDirs {
  private readonly dirs: string[] = [];

  tmp(prefix = 'vd-bench-'): string {
    const d = mkdtempSync(path.join(os.tmpdir(), prefix));
    this.dirs.push(d);
    return d;
  }

  cleanup(): void {
    for (const d of this.dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    this.dirs.length = 0;
  }
}

export interface LinkedPeer {
  readonly session: DiscoverySession;
  readonly link: Promise<PeerLink>;
  readonly resolveLink: (l: PeerLink) => void;
}

/** Spawn a discovery node that captures its first PeerLink. */
export async function spawnLinked(
  peerHello: PeerHello,
  topic: Buffer,
  bootstrap: Bootstrap,
  stateDir: string,
): Promise<{ session: DiscoverySession; linkP: Promise<PeerLink> }> {
  let resolveLink!: (l: PeerLink) => void;
  const linkP = new Promise<PeerLink>((r) => {
    resolveLink = r;
  });
  const session = await startDiscovery({
    hello: peerHello,
    topic,
    bootstrap,
    stateDir,
    notify: () => {},
    onLink: (l) => resolveLink(l),
  });
  return { session, linkP };
}

export async function spawnRoom(
  peerHello: PeerHello,
  room: string,
  bootstrap: Bootstrap,
  stateDir: string,
): Promise<RoomSession> {
  return startRoom({
    hello: peerHello,
    room,
    bootstrap,
    stateDir,
    notify: () => {},
  });
}

export { randomTopic, startDiscovery };
