# vibedating

Dating by tokens — connect your Claude Code / Codex usage, get sorted into a
**league** (1M / 5M / 10M / 100M / 1B+), and match with people who burn tokens
the way you do. The premise: heavy users of these tools share something worth
matching on.

Part of the **Vibe Suite** — companion tools for agentic coding CLIs. Ships as
**CLI + npm package + MCP server**, plus a local web app. Built on
[`@pooriaarab/vibe-core`](https://www.npmjs.com/package/@pooriaarab/vibe-core).

> **Local-first.** Raw token usage is read and stored on your own machine and
> **never leaves it.** Only the coarse league *bucket* is ever shared — never the
> raw number, never per-project breakdowns. Live matching is peer-to-peer over a
> DHT (no central server) and **opt-in only**; without it the pool is a local
> seeded demo.

## Status

**v0 — works locally, privacy-first.** Verification via read-only OAuth
(`verified: true`) is the deliberate next step; the seam exists
([`tryReadVerifiedUsage`](src/index.ts)). For now usage is **self-reported**
(`verified: false`), read locally or supplied by you.

## Install

```bash
npm install -g vibedate
```

…or run it ad-hoc:

```bash
npx vibedate connect
```

## Quick start

```bash
# 1. Read your usage, compute + print your league (stored locally at ~/.vibedating)
vibedating connect

# 2. See candidates in your league (same or adjacent tier)
vibedating matches

# 3. (Opt-in) find live same-league peers over the DHT — no server
vibedating discover --live        # shares ONLY handle + league + harness

# 4. Open the local web app in your browser (served from your machine)
vibedating open
```

Self-report a token count (otherwise a demo value is used):

```bash
VIBEDATING_TOKENS=23400000 vibedating connect   # also accepts 12M / 1.2B / 500k
```

### All commands

```
vibedating connect            Read usage, compute + print your league
vibedating matches [--live]   List candidates in your league (live peers if any)
vibedating discover [--live]  Find live same-league peers over the DHT (opt-in)
vibedating open [--port N]    Serve the local web app (default: random free port)
vibedating mcp                Run the stdio MCP server (tools: profile, matches)
vibedating --version
vibedating --help
```

### Live P2P discovery (opt-in)

`vibedating discover --live` joins the public [hyperswarm](https://github.com/holepunchto/hyperswarm)
DHT on your league topic — `sha256('vibedate:' + leagueBucket)` — so same-league
peers find each other with **no central server**. On each encrypted connection
the two sides exchange a one-line hello with exactly
`{ handle, league, harness }`; raw usage is never put on the wire. Discovered
peers are stored in `~/.vibedating/peers.json` and shown by `vibedating matches`.

Live discovery is **off by default**. The `--live` flag is the explicit opt-in
(persisted as the `share:live` consent scope); every live run prints what it
shares before joining. `Ctrl+C` leaves the swarm cleanly.

## Three faces, one local engine

The same local engine drives all three, so you can use it wherever you work:

- **Web** — `vibedating open` serves the dating UI (profile, match stack, league
  ladder) at `http://localhost:PORT`. The page reads your league + matches from a
  tiny local JSON endpoint.
- **CLI** — `vibedating connect` / `matches`.
- **MCP** — `vibedating mcp` exposes `profile` (your league) and `matches` to any
  MCP host (Claude Code, Codex, Cursor, …).

### As a library

```ts
import { league, matches, readUsage, CANDIDATES } from 'vibedate';

const usage = await readUsage('claude-code');     // { totalTokens, verified, ... }
const lg = league(usage.totalTokens);             // { name: '10M', min: 10_000_000 }
const who = matches(lg.name, CANDIDATES);         // same/adjacent-tier candidates
```

## Privacy

- **Raw usage stays local.** `totalTokens` is read into memory, stored at
  `~/.vibedating/state.json`, and shown in the web app only behind an opt-in
  toggle. It is never transmitted.
- **Only the league bucket is shared** — with the local demo pool, and (only if
  you opt in with `--live`) as `{ handle, league, harness }` with same-league
  peers over the hyperswarm DHT. The handshake parser whitelists those three
  fields, so a peer can't even be *sent* anything else into your process.
- Consent for sharing the league is modeled with `@pooriaarab/vibe-core`'s consent
  ledger (scope `share:league`), granted on `connect` and revocable on reset.
  Live P2P discovery has its own scope (`share:live`), default **off**.

## Leagues & matching

Bucketed by lifetime tokens; you match within your league **or an adjacent tier**
(so the tiny 1B+ pool still has people to match with):

| League | Tokens (lifetime) |
| ------ | ----------------- |
| 1M     | 1M – 4.99M        |
| 5M     | 5M – 9.99M        |
| 10M    | 10M – 99.9M       |
| 100M   | 100M – 999M       |
| 1B+    | 1B+               |

## Prototype

An interactive, self-contained UX prototype (no build, no network):
[`docs/prototype.html`](docs/prototype.html). The shipped local web app
(`vibedating open`) is an adapted, data-driven version of this prototype.

## License

MIT
