#!/usr/bin/env node
/**
 * vibedating CLI — three faces, one local engine (web / CLI / MCP).
 *
 *   vibedating connect          read usage, compute + print your league
 *   vibedating matches          list candidates in your league
 *   vibedating open             serve the local web app at http://localhost:PORT
 *   vibedating mcp              run the stdio MCP server
 *   vibedating --version
 *   vibedating --help
 *
 * No new deps: a tiny hand-rolled arg parser (parseArgs) over process.argv.
 */
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { CANDIDATES, league, matches, readUsage, type Harness } from './index.js';
import { connectProfile, loadProfile } from './state.js';
import { startServer } from './server.js';
import { runMcp } from './mcp.js';

/** Mirrors package.json version (kept here; package.json imports are brittle under bundling). */
const VERSION = '0.1.0';

/** Recognized top-level commands, plus the synthetic help/version. */
export type Command = 'connect' | 'matches' | 'open' | 'mcp' | 'help' | 'version' | null;

export interface ParsedArgs {
  readonly command: Command;
  /** Port for `open --port`; undefined means "let the OS pick". */
  readonly port: number | undefined;
}

function parsePort(raw: string): number | undefined {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return undefined;
  return n;
}

/**
 * Parse argv (the slice AFTER the program name) into a command + options.
 * Pure: no IO, no process access — trivially unit-testable.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  let out: ParsedArgs = { command: null, port: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--version' || a === '-v') return { command: 'version', port: undefined };
    if (a === '--help' || a === '-h') return { command: 'help', port: undefined };
    if (a === '--port') {
      const next = argv[i + 1];
      if (next !== undefined) {
        const p = parsePort(next);
        if (p !== undefined) out = { ...out, port: p };
        i++;
      }
      continue;
    }
    if (a.startsWith('--port=')) {
      const p = parsePort(a.slice('--port='.length));
      if (p !== undefined) out = { ...out, port: p };
      continue;
    }
    if (a.startsWith('-')) continue; // ignore unknown flags
    const known: Command =
      a === 'connect' || a === 'matches' || a === 'open' || a === 'mcp' || a === 'help'
        ? a
        : null;
    if (known !== null && out.command === null) {
      out = { ...out, command: known };
    }
  }
  return out;
}

function leagueLabel(name: string): string {
  return name === 'below-1M' ? 'below 1M (not yet in a league)' : `${name} League`;
}

async function cmdConnect(): Promise<number> {
  const harness: Harness = (process.env['VIBEDATING_HARNESS'] as Harness | undefined) ?? 'claude-code';
  const handle = process.env['VIBEDATING_HANDLE'] ?? '@you';
  const snapshot = await readUsage(harness);
  const profile = connectProfile(snapshot, handle);
  const lg = league(snapshot.totalTokens);
  process.stdout.write('\n');
  process.stdout.write(`  ${leagueLabel(lg.name)}\n`);
  process.stdout.write(`  handle: ${profile.handle}  ·  harness: ${profile.harness}\n`);
  process.stdout.write(
    `  verification: ${profile.verified ? 'verified (read-only OAuth)' : 'self-reported'}\n`,
  );
  process.stdout.write('\n');
  process.stdout.write('  • raw usage stays local · only league shared\n\n');
  return 0;
}

async function cmdMatches(): Promise<number> {
  const profile = loadProfile();
  if (!profile) {
    process.stderr.write('Not connected yet. Run `vibedating connect` first.\n');
    return 1;
  }
  const list = matches(profile.league, CANDIDATES);
  process.stdout.write(`Your league: ${leagueLabel(profile.league)}\n`);
  process.stdout.write(`${list.length} candidate${list.length === 1 ? '' : 's'} in range:\n\n`);
  if (list.length === 0) {
    process.stdout.write('  (no candidates in range)\n');
    return 0;
  }
  for (const c of list) {
    process.stdout.write(`  ${c.handle.padEnd(28)} ${c.league}\n`);
  }
  process.stdout.write('\n');
  return 0;
}

async function cmdOpen(port: number | undefined): Promise<number> {
  const { url } = await startServer({ port });
  process.stdout.write(`\n  vibedating local web app → ${url}\n\n`);
  process.stdout.write('  • raw usage stays local · only league shared\n');
  process.stdout.write('  (Ctrl+C to stop)\n\n');
  return 0;
}

const HELP = `vibedating ${VERSION} — dating by tokens (local-first)

Usage:
  vibedating connect            Read your usage, compute + print your league
  vibedating matches            List candidates in your league
  vibedating open [--port N]    Serve the local web app (default: random port)
  vibedating mcp                Run the stdio MCP server (profile, matches)
  vibedating --version
  vibedating --help

Privacy:
  Raw token usage is read and stored LOCALLY (~/.vibedating). Only the league
  bucket is ever shared. v0 has no central directory — the pool is a seeded demo.

Env:
  VIBEDATING_TOKENS=<n>   Self-report a token count (e.g. 23400000 or 12M)
  VIBEDATING_HARNESS=<h>  Harness id (claude-code, codex, …)
  VIBEDATING_HANDLE=<@id> Display handle
`;

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  switch (parsed.command) {
    case 'version':
      process.stdout.write(`vibedating ${VERSION}\n`);
      return 0;
    case 'help':
    case null:
      process.stdout.write(HELP);
      return 0;
    case 'connect':
      return cmdConnect();
    case 'matches':
      return cmdMatches();
    case 'open':
      return cmdOpen(parsed.port);
    case 'mcp':
      await runMcp();
      return 0;
  }
}

// Run only when invoked as the entry script (not when imported, e.g. by tests).
const entryUrl = process.argv[1];
if (entryUrl !== undefined) {
  let isMain = false;
  try {
    isMain = import.meta.url === pathToFileURL(entryUrl).href;
  } catch {
    isMain = false;
  }
  if (isMain) {
    void main(process.argv.slice(2)).then(
      (code) => {
        if (code !== 0) process.exit(code);
      },
      (err) => {
        process.stderr.write(err instanceof Error ? `${err.stack ?? err.message}\n` : `${String(err)}\n`);
        process.exit(1);
      },
    );
  }
}
