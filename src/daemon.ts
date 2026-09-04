/**
 * Notify-only daemon — lifecycle + state, no swarm code.
 *
 * `vibedate daemon start` spawns a detached `vibedate daemon run` child that
 * joins discovery and fires vibe-core `notify()` on each NEW match (the
 * notify-on-new-match logic already lives in startDiscovery; the daemon never
 * passes `onLink`, so chat/video are NEVER auto-opened). The child needs NO
 * stdin — it runs until SIGTERM/SIGINT.
 *
 * State is a pidfile at `~/.vibedating/daemon.json`; child output appends to
 * `~/.vibedating/daemon.log`. `daemon stop` SIGTERMs the pid; `daemon status`
 * reports liveness and reaps a stale pidfile. Process control is injectable
 * so the lifecycle is unit-testable without real children.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultStateDir } from './state.js';
import {
  daemonServicePath,
  defaultRun,
  installDarwinService,
  installSystemdService,
  resolveServiceInstallPaths,
  SYSTEMD_UNIT_NAME,
  type ServiceInstallResult,
  type ServiceOptions,
} from './daemon-service.js';

export {
  DAEMON_SERVICE_LABEL,
  daemonServicePath,
  renderLaunchdPlist,
  renderSystemdUnit,
  type RunFn,
  type ServiceInstallResult,
  type ServiceOptions,
} from './daemon-service.js';

/** The pidfile state persisted while the daemon runs. */
export interface DaemonState {
  readonly pid: number;
  readonly startedAt: string;
  /** Discovery scope: true = every league, false = own league ±1. */
  readonly any: boolean;
  readonly version: string;
}

export function daemonStatePath(dir: string): string {
  return path.join(dir, 'daemon.json');
}

/** Where the detached child's stdout/stderr lands. */
export function daemonLogPath(dir: string): string {
  return path.join(dir, 'daemon.log');
}

/** Read the pidfile, or `null` when absent/corrupt/misshapen. Never throws. */
export function readDaemonState(dir: string = defaultStateDir()): DaemonState | null {
  try {
    const raw = readFileSync(daemonStatePath(dir), 'utf8');
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof data['pid'] !== 'number' ||
      !Number.isInteger(data['pid']) ||
      data['pid'] <= 0 ||
      typeof data['startedAt'] !== 'string' ||
      typeof data['any'] !== 'boolean' ||
      typeof data['version'] !== 'string'
    ) {
      return null;
    }
    return { pid: data['pid'], startedAt: data['startedAt'], any: data['any'], version: data['version'] };
  } catch {
    return null;
  }
}

export function writeDaemonState(dir: string, state: DaemonState): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(daemonStatePath(dir), JSON.stringify(state, null, 2) + '\n', 'utf8');
}

export function removeDaemonState(dir: string = defaultStateDir()): void {
  try {
    rmSync(daemonStatePath(dir), { force: true });
  } catch {
    /* already gone */
  }
}

/** Signature of `process.kill` (injectable for tests). */
export type KillFn = (pid: number, signal?: string | number) => boolean;

/**
 * Whether `pid` refers to a live process: signal 0 probes existence without
 * delivering anything. EPERM means "exists but owned by someone else" — still
 * alive. Any other error (ESRCH, EINVAL) means gone.
 */
export function isPidAlive(pid: number, kill: KillFn = process.kill): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface DaemonStatus {
  readonly running: boolean;
  readonly state: DaemonState | null;
}

/** Report liveness from the pidfile; a stale pidfile (dead pid) is reaped. */
export function daemonStatus(
  dir: string = defaultStateDir(),
  alive: (pid: number) => boolean = isPidAlive,
): DaemonStatus {
  const state = readDaemonState(dir);
  if (state === null) return { running: false, state: null };
  if (alive(state.pid)) return { running: true, state };
  removeDaemonState(dir);
  return { running: false, state: null };
}

export type StartDaemonResult = { started: true; pid: number } | { started: false; reason: string };

/** Default spawner: detached child, stdin ignored, output appended to the log. */
function defaultSpawn(execPath: string, scriptPath: string, args: string[], logPath: string): number {
  mkdirSync(path.dirname(logPath), { recursive: true });
  const fd = openSync(logPath, 'a');
  const child = spawn(execPath, [scriptPath, ...args], {
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  child.unref();
  if (child.pid === undefined) throw new Error('could not spawn daemon child process');
  return child.pid;
}

export interface StartDaemonOptions {
  readonly any: boolean;
  readonly version: string;
  readonly dir?: string;
  readonly execPath?: string;
  readonly scriptPath?: string;
  /** Injectable spawner (tests substitute a fake). Returns the child pid. */
  readonly spawnProcess?: (args: readonly string[], logPath: string) => number;
  readonly alive?: (pid: number) => boolean;
}

/**
 * Spawn the notify-only daemon in the background and write the pidfile.
 * Refuses to double-start: an already-running daemon is reported, not replaced.
 */
export function startDaemon(opts: StartDaemonOptions): StartDaemonResult {
  const dir = opts.dir ?? defaultStateDir();
  const status = daemonStatus(dir, opts.alive);
  if (status.running && status.state !== null) {
    return { started: false, reason: `already running (pid ${status.state.pid})` };
  }
  const execPath = opts.execPath ?? process.execPath;
  const scriptPath = opts.scriptPath ?? process.argv[1];
  if (scriptPath === undefined) return { started: false, reason: 'cannot locate the CLI entry point' };
  const args = ['daemon', 'run', ...(opts.any ? ['--any'] : [])];
  const spawnProcess =
    opts.spawnProcess ?? ((a: readonly string[], logPath: string) => defaultSpawn(execPath, scriptPath, [...a], logPath));
  const pid = spawnProcess(args, daemonLogPath(dir));
  writeDaemonState(dir, { pid, startedAt: new Date().toISOString(), any: opts.any, version: opts.version });
  return { started: true, pid };
}

export type StopDaemonResult = { stopped: true; pid: number } | { stopped: false; reason: string };

export interface StopDaemonOptions {
  readonly dir?: string;
  readonly kill?: KillFn;
  readonly alive?: (pid: number) => boolean;
  /** Max time to wait for a clean SIGTERM exit before giving up (ms). */
  readonly waitMs?: number;
}

/**
 * SIGTERM the daemon and remove the pidfile. Idempotent: no pidfile (or a
 * stale one) is a clean "not running", not an error.
 */
/**
 * Resolve the daemon state for stopping: null when not running or stale.
 * Module-private; reduces complexity in stopDaemon.
 */
function resolveStopState(
  dir: string,
  alive: (pid: number) => boolean,
): DaemonState | 'not running' | 'cleaned stale' {
  const state = readDaemonState(dir);
  if (state === null) return 'not running';
  if (!alive(state.pid)) {
    removeDaemonState(dir);
    return 'cleaned stale';
  }
  return state;
}

/** SIGTERM a pid; suppress already-exiting noise. Module-private. */
function sigtermPid(pid: number, kill: KillFn): void {
  try {
    kill(pid, 'SIGTERM');
  } catch {
    /* already exiting */
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForExit(
  deadline: number,
  pid: number,
  alive: (pid: number) => boolean,
): Promise<void> {
  if (Date.now() >= deadline || !alive(pid)) return;
  await sleep(50);
  return waitForExit(deadline, pid, alive);
}

export async function stopDaemon(opts: StopDaemonOptions = {}): Promise<StopDaemonResult> {
  const dir = opts.dir ?? defaultStateDir();
  const kill: KillFn = opts.kill ?? process.kill;
  const alive = opts.alive ?? ((pid: number) => isPidAlive(pid, kill));
  const resolved = resolveStopState(dir, alive);
  if (resolved === 'not running') return { stopped: false, reason: 'not running' };
  if (resolved === 'cleaned stale') return { stopped: false, reason: 'not running (cleaned stale pidfile)' };
  const state = resolved;
  sigtermPid(state.pid, kill);
  await waitForExit(Date.now() + (opts.waitMs ?? 2_000), state.pid, alive);
  removeDaemonState(dir);
  return { stopped: true, pid: state.pid };
}

/**
 * Install the daemon as a login service (opt-in onboarding): launchd agent on
 * macOS, systemd --user unit on Linux. Reversible via {@link uninstallDaemonService}.
 */
export function installDaemonService(opts: ServiceOptions): ServiceInstallResult {
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? defaultRun;
  const paths = resolveServiceInstallPaths(opts);
  if ('error' in paths) return paths.error;
  const { servicePath, execPath, scriptPath } = paths;
  mkdirSync(path.dirname(servicePath), { recursive: true });
  if (platform === 'darwin') {
    const logPath = daemonLogPath(opts.dir ?? defaultStateDir());
    return installDarwinService({
      execPath,
      scriptPath,
      any: opts.any,
      servicePath,
      logPath,
      run,
    });
  }
  return installSystemdService({ servicePath, execPath, scriptPath, any: opts.any, run });
}

/** Remove the login service installed by {@link installDaemonService}. Idempotent. */
export function uninstallDaemonService(opts: Omit<ServiceOptions, 'any'>): ServiceInstallResult {
  const platform = opts.platform ?? process.platform;
  const homeDir = opts.homeDir ?? os.homedir();
  const run = opts.run ?? defaultRun;
  const servicePath = daemonServicePath(platform, homeDir);
  if (servicePath === null) {
    return {
      installed: false,
      servicePath: null,
      detail: `unsupported platform (${platform})`,
    };
  }
  if (platform === 'darwin') {
    const uid = process.getuid?.() ?? 501;
    run('launchctl', ['bootout', `gui/${uid}`, servicePath]); // best-effort
  } else {
    run('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT_NAME]); // best-effort
    run('systemctl', ['--user', 'daemon-reload']); // best-effort
  }
  try {
    rmSync(servicePath, { force: true });
  } catch {
    /* already gone */
  }
  return { installed: false, servicePath, detail: 'login service removed — the daemon no longer starts on login' };
}
