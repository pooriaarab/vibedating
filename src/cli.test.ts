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
