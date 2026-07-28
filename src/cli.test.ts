import { describe, expect, it } from 'vitest';
import { parseArgs } from './cli.js';

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
    expect(parseArgs(['discover', '--live'])).toEqual({ command: 'discover', port: undefined, live: true, dating: false, any: false });
    expect(parseArgs(['--live', 'matches'])).toEqual({ command: 'matches', port: undefined, live: true, dating: false, any: false });
  });

  it('combines with --port', () => {
    expect(parseArgs(['open', '--live', '--port', '8080'])).toEqual({
      command: 'open',
      port: 8080,
      live: true,
      dating: false,
      any: false,
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
    expect(parseArgs(['open', '--port', '8080'])).toEqual({ command: 'open', port: 8080, live: false, dating: false, any: false });
  });

  it('accepts --port=<n>', () => {
    expect(parseArgs(['open', '--port=8080'])).toEqual({ command: 'open', port: 8080, live: false, dating: false, any: false });
  });

  it('rejects out-of-range / non-numeric ports (undefined, command intact)', () => {
    expect(parseArgs(['open', '--port', 'nope'])).toEqual({ command: 'open', port: undefined, live: false, dating: false, any: false });
    expect(parseArgs(['open', '--port', '0']).port).toBeUndefined();
    expect(parseArgs(['open', '--port', '70000']).port).toBeUndefined();
  });

  it('ignores --port with no following value', () => {
    expect(parseArgs(['open', '--port'])).toEqual({ command: 'open', port: undefined, live: false, dating: false, any: false });
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
    });
  });

  it('combines --dating with --live semantics on discover (flags are independent)', () => {
    expect(parseArgs(['discover', '--live', '--dating'])).toEqual({
      command: 'discover',
      port: undefined,
      live: true,
      dating: true,
      any: false,
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
    });
    expect(parseArgs(['live', '--any'])).toEqual({
      command: 'live',
      port: undefined,
      live: false,
      dating: false,
      any: true,
    });
  });

  it('sets any on open (same scoping as discover/live)', () => {
    expect(parseArgs(['open', '--any'])).toEqual({
      command: 'open',
      port: undefined,
      live: false,
      dating: false,
      any: true,
    });
    expect(parseArgs(['open', '--any', '--port', '8080'])).toEqual({
      command: 'open',
      port: 8080,
      live: false,
      dating: false,
      any: true,
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
    });
    expect(parseArgs(['live', '--dating', '--any'])).toEqual({
      command: 'live',
      port: undefined,
      live: false,
      dating: true,
      any: true,
    });
  });
});
