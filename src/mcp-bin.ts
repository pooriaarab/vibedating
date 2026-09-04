#!/usr/bin/env node
/**
 * Dedicated executable for the `vibedate-mcp` bin.
 *
 * Its ONLY job is to start the stdio MCP server, so it calls `runMcp`
 * unconditionally — no `import.meta.url` main-guard. That guard can't work in
 * this project: `tsup` code-splits the multi-entry build, emitting each entry as
 * a thin re-export barrel over shared chunks, so a guard inside mcp.ts would
 * compare the chunk's URL (never the bin the user launched) and always be false —
 * the module would load, define, and exit, which an MCP client sees as a silent
 * "failed / not connected". A separate entry that just runs sidesteps all of it.
 */
import { runMcp } from './mcp.js';

runMcp().catch((err: unknown) => {
  process.stderr.write(
    `vibedate-mcp: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
