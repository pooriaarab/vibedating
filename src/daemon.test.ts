import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  daemonLogPath,
  daemonStatePath,
  daemonStatus,
  isPidAlive,
  readDaemonState,
  removeDaemonState,
  startDaemon,
  stopDaemon,
  writeDaemonState,
  type DaemonState,
} from './daemon.js';

const STATE: DaemonState = { pid: 4242, startedAt: '2026-07-28T00:00:00.000Z', any: true, version: '0.4.1' };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'vibedating-daemon-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('daemon state file', () => {
  it('write → read round-trips; remove clears it', () => {
    expect(readDaemonState(dir)).toBeNull();
    writeDaemonState(dir, STATE);
    expect(readDaemonState(dir)).toEqual(STATE);
    const raw = JSON.parse(readFileSync(daemonStatePath(dir), 'utf8')) as DaemonState;
    expect(raw.pid).toBe(4242);
    removeDaemonState(dir);
    expect(readDaemonState(dir)).toBeNull();
  });

  it('read returns null on corrupt or misshapen content', () => {
    writeFileSync(daemonStatePath(dir), '{not json', 'utf8');
    expect(readDaemonState(dir)).toBeNull();
    writeFileSync(daemonStatePath(dir), '{"pid":"nope"}', 'utf8');
    expect(readDaemonState(dir)).toBeNull();
    writeFileSync(daemonStatePath(dir), '{"pid":-3,"startedAt":"x","any":true,"version":"v"}', 'utf8');
    expect(readDaemonState(dir)).toBeNull();
  });

  it('log path lives next to the pidfile', () => {
    expect(daemonLogPath(dir)).toBe(path.join(dir, 'daemon.log'));
  });
});

describe('isPidAlive()', () => {
  it('true when the probe succeeds, false on ESRCH, true on EPERM', () => {
    expect(isPidAlive(1, () => true)).toBe(true);
    expect(
      isPidAlive(1, () => {
        const err = new Error('no such process') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }),
    ).toBe(false);
    expect(
      isPidAlive(1, () => {
        const err = new Error('not permitted') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }),
    ).toBe(true);
  });

  it('the current process is alive by the real probe', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });
});

describe('daemonStatus()', () => {
  it('not running with no pidfile', () => {
    expect(daemonStatus(dir)).toEqual({ running: false, state: null });
  });

  it('running with a live pid', () => {
    writeDaemonState(dir, STATE);
    expect(daemonStatus(dir, () => true)).toEqual({ running: true, state: STATE });
  });

  it('reaps a stale pidfile (dead pid)', () => {
    writeDaemonState(dir, STATE);
    expect(daemonStatus(dir, () => false)).toEqual({ running: false, state: null });
    expect(readDaemonState(dir)).toBeNull();
  });
});

describe('startDaemon()', () => {
  it('spawns `daemon run` detached and writes the pidfile', () => {
    const calls: { args: readonly string[]; logPath: string }[] = [];
    const r = startDaemon({
      any: true,
      version: '0.4.1',
      dir,
      spawnProcess: (args, logPath) => {
        calls.push({ args, logPath });
        return 4321;
      },
    });
    expect(r).toEqual({ started: true, pid: 4321 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(['daemon', 'run', '--any']);
    expect(calls[0]!.logPath).toBe(daemonLogPath(dir));
    const state = readDaemonState(dir);
    expect(state?.pid).toBe(4321);
    expect(state?.any).toBe(true);
  });

  it('omits --any in the adjacent-league scope', () => {
    const calls: { args: readonly string[] }[] = [];
    startDaemon({
      any: false,
      version: '0.4.1',
      dir,
      spawnProcess: (args) => {
        calls.push({ args });
        return 7;
      },
    });
    expect(calls[0]!.args).toEqual(['daemon', 'run']);
  });

  it('refuses to double-start an already-running daemon', () => {
    writeDaemonState(dir, STATE);
    let spawned = 0;
    const r = startDaemon({
      any: false,
      version: '0.4.1',
      dir,
      alive: () => true,
      spawnProcess: () => {
        spawned++;
        return 9;
      },
    });
    expect(r).toEqual({ started: false, reason: 'already running (pid 4242)' });
    expect(spawned).toBe(0);
  });

  it('restarts cleanly over a stale pidfile', () => {
    writeDaemonState(dir, STATE);
    const r = startDaemon({
      any: false,
      version: '0.4.1',
      dir,
      alive: () => false,
      spawnProcess: () => 5555,
    });
    expect(r).toEqual({ started: true, pid: 5555 });
    expect(readDaemonState(dir)?.pid).toBe(5555);
  });
});

describe('stopDaemon()', () => {
  it('no pidfile → clean "not running"', async () => {
    expect(await stopDaemon({ dir })).toEqual({ stopped: false, reason: 'not running' });
  });

  it('stale pidfile → reaped, no kill attempted', async () => {
    writeDaemonState(dir, STATE);
    let kills = 0;
    const r = await stopDaemon({
      dir,
      alive: () => false,
      kill: () => {
        kills++;
        return true;
      },
    });
    expect(r).toEqual({ stopped: false, reason: 'not running (cleaned stale pidfile)' });
    expect(kills).toBe(0);
    expect(readDaemonState(dir)).toBeNull();
  });

  it('SIGTERMs a live daemon and removes the pidfile once it exits', async () => {
    writeDaemonState(dir, STATE);
    const signals: (string | number | undefined)[] = [];
    let probes = 0;
    const r = await stopDaemon({
      dir,
      waitMs: 500,
      kill: (_pid, signal) => {
        signals.push(signal);
        return true;
      },
      alive: () => {
        probes++;
        return probes === 1; // alive before SIGTERM, dead right after
      },
    });
    expect(r).toEqual({ stopped: true, pid: 4242 });
    expect(signals).toEqual(['SIGTERM']);
    expect(readDaemonState(dir)).toBeNull();
  });
});
