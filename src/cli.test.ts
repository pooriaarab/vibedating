import { describe, expect, it } from 'vitest';
import { formatAgo, parseArgs, shouldKeepAlive } from './cli.js';

describe('parseArgs — commands', () => {
  it('recognizes each subcommand', () => {
    expect(parseArgs(['connect']).command).toBe('connect');
    expect(parseArgs(['matches']).command).toBe('matches');
    expect(parseArgs(['discover']).command).toBe('discover');
    expect(parseArgs(['open']).command).toBe('open');
    expect(parseArgs(['live']).command).toBe('live');
    expect(parseArgs(['mcp']).command).toBe('mcp');
  });

  it('no args → null command (shows help)', () => {
    expect(parseArgs([]).command).toBe(null);
  });
});

describe('parseArgs — --live opt-in flag', () => {
  it('defaults to false', () => {
    expect(parseArgs(['discover']).live).toBe(false);
    expect(parseArgs(['matches']).live).toBe(false);
  });

  it('sets live on discover and matches', () => {
    expect(parseArgs(['discover', '--live'])).toEqual({ command: 'discover', port: undefined, live: true, dating: false, any: false, keepAlive: false, viaRelay: false });
    expect(parseArgs(['--live', 'matches'])).toEqual({ command: 'matches', port: undefined, live: true, dating: false, any: false, keepAlive: false, viaRelay: false });
  });

  it('combines with --port', () => {
    expect(parseArgs(['open', '--live', '--port', '8080'])).toEqual({
      command: 'open',
      port: 8080,
      live: true,
      dating: false,
      any: false,
      keepAlive: false,
      viaRelay: false,
    });
  });
});

describe('parseArgs — version / help flags', () => {
  it('short and long version', () => {
    expect(parseArgs(['--version']).command).toBe('version');
    expect(parseArgs(['-v']).command).toBe('version');
  });

  it('short and long help', () => {
    expect(parseArgs(['--help']).command).toBe('help');
    expect(parseArgs(['-h']).command).toBe('help');
  });

  it('version wins even if a command is also present', () => {
    expect(parseArgs(['connect', '--version']).command).toBe('version');
  });
});

describe('parseArgs — open --port', () => {
  it('accepts --port <n>', () => {
    expect(parseArgs(['open', '--port', '8080'])).toEqual({ command: 'open', port: 8080, live: false, dating: false, any: false, keepAlive: false, viaRelay: false });
  });

  it('accepts --port=<n>', () => {
    expect(parseArgs(['open', '--port=8080'])).toEqual({ command: 'open', port: 8080, live: false, dating: false, any: false, keepAlive: false, viaRelay: false });
  });

  it('rejects out-of-range / non-numeric ports (undefined, command intact)', () => {
    expect(parseArgs(['open', '--port', 'nope'])).toEqual({ command: 'open', port: undefined, live: false, dating: false, any: false, keepAlive: false, viaRelay: false });
    expect(parseArgs(['open', '--port', '0']).port).toBeUndefined();
    expect(parseArgs(['open', '--port', '70000']).port).toBeUndefined();
  });

  it('ignores --port with no following value', () => {
    expect(parseArgs(['open', '--port'])).toEqual({ command: 'open', port: undefined, live: false, dating: false, any: false, keepAlive: false, viaRelay: false });
  });
});

describe('parseArgs — robustness', () => {
  it('unknown subcommand → null (falls through to help)', () => {
    expect(parseArgs(['frobnicate']).command).toBe(null);
  });

  it('first real subcommand wins', () => {
    expect(parseArgs(['connect', 'matches']).command).toBe('connect');
  });

  it('ignores unknown flags', () => {
    expect(parseArgs(['--bogus', 'connect']).command).toBe('connect');
  });
});

describe('parseArgs — live --dating', () => {
  it('dating defaults to false', () => {
    expect(parseArgs(['live']).dating).toBe(false);
    expect(parseArgs(['discover']).dating).toBe(false);
  });

  it('sets dating on live', () => {
    expect(parseArgs(['live', '--dating'])).toEqual({
      command: 'live',
      port: undefined,
      live: false,
      dating: true,
      any: false,
      keepAlive: false,
      viaRelay: false,
    });
  });

  it('combines --dating with --live semantics on discover (flags are independent)', () => {
    expect(parseArgs(['discover', '--live', '--dating'])).toEqual({
      command: 'discover',
      port: undefined,
      live: true,
      dating: true,
      any: false,
      keepAlive: false,
      viaRelay: false,
    });
  });
});

describe('parseArgs — handle command + positional arg', () => {
  it('recognizes the handle subcommand', () => {
    expect(parseArgs(['handle']).command).toBe('handle');
  });

  it('no positional → arg undefined (print current handle)', () => {
    const p = parseArgs(['handle']);
    expect(p.command).toBe('handle');
    expect(p.arg).toBeUndefined();
  });

  it('captures the first positional as arg', () => {
    expect(parseArgs(['handle', '@alice']).arg).toBe('@alice');
    expect(parseArgs(['handle', 'alice']).arg).toBe('alice'); // leading '@' optional at parse time
  });

  it('does not capture the command token itself as arg', () => {
    expect(parseArgs(['handle']).arg).toBeUndefined();
  });

  it('combines with flags without losing the arg', () => {
    const p = parseArgs(['handle', '@x', '--bogus']);
    expect(p.command).toBe('handle');
    expect(p.arg).toBe('@x');
  });
});

describe('parseArgs — find command + live --to flag', () => {
  it('recognizes the find subcommand', () => {
    expect(parseArgs(['find']).command).toBe('find');
  });

  it('find captures the target handle as arg', () => {
    expect(parseArgs(['find', '@alice']).arg).toBe('@alice');
    expect(parseArgs(['find', 'alice']).arg).toBe('alice');
  });

  it('find combines with --any', () => {
    const p = parseArgs(['find', '@alice', '--any']);
    expect(p.command).toBe('find');
    expect(p.arg).toBe('@alice');
    expect(p.any).toBe(true);
  });

  it('to defaults to undefined', () => {
    expect(parseArgs(['live']).to).toBeUndefined();
    expect(parseArgs(['live', '--dating']).to).toBeUndefined();
  });

  it('live --to <@handle> sets to', () => {
    expect(parseArgs(['live', '--to', '@alice'])).toMatchObject({
      command: 'live',
      to: '@alice',
    });
  });

  it('live --to=<@handle> sets to', () => {
    expect(parseArgs(['live', '--to=@alice']).to).toBe('@alice');
  });

  it('live --to with no following value leaves to undefined', () => {
    expect(parseArgs(['live', '--to']).to).toBeUndefined();
  });

  it('live --to combines with --dating and --any', () => {
    expect(parseArgs(['live', '--dating', '--any', '--to', '@x'])).toMatchObject({
      command: 'live',
      dating: true,
      any: true,
      to: '@x',
    });
  });
});

describe('parseArgs — block / unblock / blocklist commands', () => {
  it('recognizes each subcommand', () => {
    expect(parseArgs(['block']).command).toBe('block');
    expect(parseArgs(['unblock']).command).toBe('unblock');
    expect(parseArgs(['blocklist']).command).toBe('blocklist');
  });

  it('block / unblock capture the target handle as arg', () => {
    expect(parseArgs(['block', '@spammer']).arg).toBe('@spammer');
    expect(parseArgs(['unblock', '@spammer']).arg).toBe('@spammer');
  });

  it('blocklist takes no arg', () => {
    expect(parseArgs(['blocklist']).arg).toBeUndefined();
  });

  it('block / unblock with no arg → arg undefined', () => {
    expect(parseArgs(['block']).arg).toBeUndefined();
    expect(parseArgs(['unblock']).arg).toBeUndefined();
  });
});

describe('parseArgs — --any flag', () => {
  it('defaults to false', () => {
    expect(parseArgs(['discover']).any).toBe(false);
    expect(parseArgs(['live']).any).toBe(false);
    expect(parseArgs(['live', '--dating']).any).toBe(false);
  });

  it('sets any on discover and live', () => {
    expect(parseArgs(['discover', '--any'])).toEqual({
      command: 'discover',
      port: undefined,
      live: false,
      dating: false,
      any: true,
      keepAlive: false,
      viaRelay: false,
    });
    expect(parseArgs(['live', '--any'])).toEqual({
      command: 'live',
      port: undefined,
      live: false,
      dating: false,
      any: true,
      keepAlive: false,
      viaRelay: false,
    });
  });

  it('sets any on open (same scoping as discover/live)', () => {
    expect(parseArgs(['open', '--any'])).toEqual({
      command: 'open',
      port: undefined,
      live: false,
      dating: false,
      any: true,
      keepAlive: false,
      viaRelay: false,
    });
    expect(parseArgs(['open', '--any', '--port', '8080'])).toEqual({
      command: 'open',
      port: 8080,
      live: false,
      dating: false,
      any: true,
      keepAlive: false,
      viaRelay: false,
    });
    expect(parseArgs(['open']).any).toBe(false);
  });

  it('combines --any with --live and --dating (all flags independent)', () => {
    expect(parseArgs(['discover', '--live', '--any'])).toEqual({
      command: 'discover',
      port: undefined,
      live: true,
      dating: false,
      any: true,
      keepAlive: false,
      viaRelay: false,
    });
    expect(parseArgs(['live', '--dating', '--any'])).toEqual({
      command: 'live',
      port: undefined,
      live: false,
      dating: true,
      any: true,
      keepAlive: false,
      viaRelay: false,
    });
  });
});

describe('parseArgs — live --keep-alive', () => {
  it('defaults to false', () => {
    expect(parseArgs(['live']).keepAlive).toBe(false);
    expect(parseArgs(['discover']).keepAlive).toBe(false);
  });

  it('sets keepAlive', () => {
    expect(parseArgs(['live', '--keep-alive']).keepAlive).toBe(true);
    expect(parseArgs(['live', '--keep-alive', '--any'])).toMatchObject({
      command: 'live',
      keepAlive: true,
      any: true,
    });
  });
});

describe('parseArgs — --via-relay fallback flag', () => {
  it('defaults to false', () => {
    expect(parseArgs(['live']).viaRelay).toBe(false);
    expect(parseArgs(['discover']).viaRelay).toBe(false);
    expect(parseArgs(['discover', '--live']).viaRelay).toBe(false);
  });

  it('sets viaRelay on live', () => {
    expect(parseArgs(['live', '--via-relay'])).toEqual({
      command: 'live',
      port: undefined,
      live: false,
      dating: false,
      any: false,
      to: undefined,
      keepAlive: false,
      viaRelay: true,
    });
  });

  it('sets viaRelay on discover', () => {
    expect(parseArgs(['discover', '--via-relay']).viaRelay).toBe(true);
  });

  it('combines --via-relay with --to and --any', () => {
    expect(parseArgs(['live', '--via-relay', '--to', '@alice', '--any'])).toMatchObject({
      command: 'live',
      viaRelay: true,
      to: '@alice',
      any: true,
    });
  });
});

describe('shouldKeepAlive() — the EOF policy', () => {
  it('interactive TTY without the flag exits on EOF (legacy behavior)', () => {
    expect(shouldKeepAlive(false, true)).toBe(false);
  });

  it('an explicit --keep-alive stays even on a TTY', () => {
    expect(shouldKeepAlive(true, true)).toBe(true);
  });

  it('non-TTY stdin auto-keeps-alive (piped / </dev/null / backgrounded)', () => {
    expect(shouldKeepAlive(false, undefined)).toBe(true);
    expect(shouldKeepAlive(false, false)).toBe(true);
    expect(shouldKeepAlive(true, undefined)).toBe(true);
  });
});

describe('formatAgo() — lastMessageAt display', () => {
  const now = new Date('2026-07-28T12:00:00.000Z');

  it('renders the compact buckets', () => {
    expect(formatAgo('2026-07-28T11:59:40.000Z', now)).toBe('just now'); // 20s
    expect(formatAgo('2026-07-28T11:55:00.000Z', now)).toBe('5m ago');
    expect(formatAgo('2026-07-28T09:00:00.000Z', now)).toBe('3h ago');
    expect(formatAgo('2026-07-26T12:00:00.000Z', now)).toBe('2d ago');
  });

  it('clamps future timestamps and survives garbage input', () => {
    expect(formatAgo('2026-07-28T13:00:00.000Z', now)).toBe('just now');
    expect(formatAgo('not a date', now)).toBe('unknown');
  });
});
