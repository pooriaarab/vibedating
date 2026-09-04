/**
 * Service-install helpers for the notify-only daemon.
 *
 * launchd on macOS, systemd --user on Linux.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* -------------------------------------------------------------------------- */
/* Login-service install (launchd on macOS, systemd --user on Linux)          */
/* -------------------------------------------------------------------------- */

/** launchd label / systemd unit name for the login service. */
export const DAEMON_SERVICE_LABEL = 'ai.vibedating.daemon';
export const SYSTEMD_UNIT_NAME = 'vibedating.service';

/**
 * Where the login-service definition lives for this platform, or `null` when
 * the platform has no supported user-service mechanism.
 */
export function daemonServicePath(
  platform: NodeJS.Platform = process.platform,
  homeDir: string = os.homedir(),
): string | null {
  if (platform === 'darwin') {
    return path.join(homeDir, 'Library', 'LaunchAgents', `${DAEMON_SERVICE_LABEL}.plist`);
  }
  if (platform === 'linux') {
    return path.join(homeDir, '.config', 'systemd', 'user', SYSTEMD_UNIT_NAME);
  }
  return null;
}

/** The argv the service runs: `node <cli> daemon run [--any]`. */
function serviceArgv(execPath: string, scriptPath: string, any: boolean): readonly string[] {
  return [execPath, scriptPath, 'daemon', 'run', ...(any ? ['--any'] : [])];
}

/** Render the launchd plist (RunAtLoad on login; output → the daemon log). Pure. */
export function renderLaunchdPlist(opts: {
  execPath: string;
  scriptPath: string;
  any: boolean;
  logPath: string;
}): string {
  const args = serviceArgv(opts.execPath, opts.scriptPath, opts.any)
    .map((a) => `    <string>${a}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${DAEMON_SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${opts.logPath}</string>
  <key>StandardErrorPath</key>
  <string>${opts.logPath}</string>
</dict>
</plist>
`;
}

/** Render the systemd --user unit (WantedBy=default.target → starts on login). Pure. */
export function renderSystemdUnit(opts: {
  execPath: string;
  scriptPath: string;
  any: boolean;
}): string {
  const execStart = serviceArgv(opts.execPath, opts.scriptPath, opts.any).join(' ');
  return `[Unit]
Description=vibedating notify-only daemon (alerts on new matches; never opens chat/video)

[Service]
ExecStart=${execStart}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
}

/** Shell-out runner for launchctl/systemctl (injectable for tests). Returns success. */
export type RunFn = (cmd: string, args: readonly string[]) => boolean;

export const defaultRun: RunFn = (cmd, args) => spawnSync(cmd, args, { stdio: 'inherit' }).status === 0;

export interface ServiceInstallResult {
  readonly installed: boolean;
  readonly servicePath: string | null;
  readonly detail: string;
}

export interface ServiceOptions {
  readonly any: boolean;
  readonly dir?: string;
  readonly platform?: NodeJS.Platform;
  readonly homeDir?: string;
  readonly execPath?: string;
  readonly scriptPath?: string;
  readonly run?: RunFn;
}

/**
 * Resolve platform, service paths, exec/script paths for service install.
 * Returns an {@link ServiceInstallResult} when an early return is needed
 * (unsupported platform / missing CLI entry), otherwise returns the resolved
 * config. Module-private; extracts early-return branches from installDaemonService.
 */
export function resolveServiceInstallPaths(
  opts: ServiceOptions,
):
  | {
      error: ServiceInstallResult;
    }
  | {
      platform: NodeJS.Platform;
      servicePath: string;
      execPath: string;
      scriptPath: string;
      run: RunFn;
    } {
  const platform = opts.platform ?? process.platform;
  const homeDir = opts.homeDir ?? os.homedir();
  const run = opts.run ?? defaultRun;
  const servicePath = daemonServicePath(platform, homeDir);
  if (servicePath === null) {
    return {
      error: {
        installed: false,
        servicePath: null,
        detail: `unsupported platform (${platform}) — run \`vibedate daemon start\` manually instead`,
      },
    };
  }
  const execPath = opts.execPath ?? process.execPath;
  const scriptPath = opts.scriptPath ?? process.argv[1];
  if (scriptPath === undefined) {
    return { error: { installed: false, servicePath, detail: 'cannot locate the CLI entry point' } };
  }
  return { platform, servicePath, execPath, scriptPath, run };
}

/** Install a launchd agent (macOS). Module-private. */
export function installDarwinService(opts: {
  execPath: string;
  scriptPath: string;
  any: boolean;
  servicePath: string;
  logPath: string;
  run: RunFn;
}): ServiceInstallResult {
  writeFileSync(
    opts.servicePath,
    renderLaunchdPlist({
      execPath: opts.execPath,
      scriptPath: opts.scriptPath,
      any: opts.any,
      logPath: opts.logPath,
    }),
    'utf8',
  );
  const uid = process.getuid?.() ?? 501;
  opts.run('launchctl', ['bootout', `gui/${uid}`, opts.servicePath]); // best-effort (may not exist)
  if (!opts.run('launchctl', ['bootstrap', `gui/${uid}`, opts.servicePath])) {
    return {
      installed: false,
      servicePath: opts.servicePath,
      detail: 'launchctl bootstrap failed — service written but not loaded',
    };
  }
  return {
    installed: true,
    servicePath: opts.servicePath,
    detail: 'launchd agent installed — the daemon starts on login',
  };
}

/** Install a systemd --user unit (Linux). Module-private. */
export function installSystemdService(opts: {
  execPath: string;
  scriptPath: string;
  any: boolean;
  servicePath: string;
  run: RunFn;
}): ServiceInstallResult {
  writeFileSync(
    opts.servicePath,
    renderSystemdUnit({ execPath: opts.execPath, scriptPath: opts.scriptPath, any: opts.any }),
    'utf8',
  );
  opts.run('systemctl', ['--user', 'daemon-reload']); // best-effort
  if (!opts.run('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT_NAME])) {
    return {
      installed: false,
      servicePath: opts.servicePath,
      detail: 'systemctl enable failed — unit written but not started',
    };
  }
  return {
    installed: true,
    servicePath: opts.servicePath,
    detail: 'systemd --user service installed — the daemon starts on login',
  };
}
