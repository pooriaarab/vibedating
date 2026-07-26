[WORKER] Implement `src/` for @pooriaarab/vibedating — a working v0. Read README.md + docs/spec.md + docs/prototype.html first (reuse the prototype HTML for the local web app UI). Scaffold is DONE — do NOT modify package.json/tsconfig/workflow/LICENSE. Implement ONLY under src/ + polish README.md.

## Build on @pooriaarab/vibe-core (already a dependency). Run `npm install` first.
Import from '@pooriaarab/vibe-core': types (UsageSnapshot, Harness), createConsentLedger. Inspect dist/index.d.ts.

## v0 scope — genuinely working locally, privacy-first. Raw usage NEVER leaves the machine; only the league bucket is shared. No real central directory in v0 (use a local seeded set of candidate profiles).

### src/index.ts — library
- `LEAGUES` + `league(totalTokens: number): { name: string; min: number }` — PURE bucketing (1M/5M/10M/100M/1B+). Unit-test boundaries hard.
- `readUsage(harness?): Promise<UsageSnapshot>` — v0: read local usage if available, else accept an injected/mock value (self-reported, verified:false). Leave a clear seam for read-only OAuth (verified:true); don't build OAuth.
- `matches(myLeague, candidates)` — filter candidates to same/adjacent league.
- A small seeded `CANDIDATES` list (abstract handles + leagues) for the local demo.

### src/cli.ts — CLI (shebang, tiny arg parse, no new deps)
- `vibedating connect` — read usage, compute + PRINT your league + a "● raw usage stays local · only league shared" note. (Store league locally.)
- `vibedating matches` — list candidates in your league.
- `vibedating open` — start a LOCAL http server (Node's built-in `http`, NO new deps) serving the dating UI (adapt docs/prototype.html) at http://localhost:PORT; print the URL. The page reads league/matches from a tiny local JSON endpoint the server exposes.
- `vibedating mcp`, `--version`, `--help`.

### src/mcp.ts — MCP server (`@modelcontextprotocol/sdk`, stdio) exposing `profile` (your league) + `matches`. Check installed SDK API.

### tests — src/*.test.ts (vitest): league() boundaries (999999→below-1M, 1_000_000→1M, etc.), matches() filtering, CLI parser. (HTTP server: a light test that it responds 200 on / is nice-to-have, not required.)

### README.md — polish for npm: keep existing, add install + quick start (`vibedating connect`, `vibedating open`) + the privacy note.

## Definition of done (run, all green): `npm install` → `npm run build` → `npm run typecheck` → `npm run test`. Strict tsconfig (`import type`, `.js` on relative imports). Commit "feat: vibedating v0 — CLI + lib + MCP + local web app" on branch build-v0. Do NOT push. Report build + tests + judgment calls.
