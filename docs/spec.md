# vibedating — spec

Status: DRAFT (Opus-authored) · 2026-07-25 · depends on `@vibe/core`
Identity: vibedating.date (available $4/yr) · ships CLI + npm + MCP (+ local web app)

## What it is
Dating by **token usage**. Connect your Claude/Codex/etc; a CLI pulls your usage;
you're sorted into a **league** (1M / 5M / 10M / 100M / 1B+) and matched with others
in your league — the premise being heavy users of these tools share something worth
matching on.

## How it runs (browser AND terminal — it's cli + npm + mcp)
- **Local web app:** the CLI spins up a **local HTTP server** (`vibedating open`) →
  the dating UI (profile, match stack, leagues) in your browser, served from your
  machine.
- **Terminal/agent:** the same actions via CLI (`vibedating matches`,
  `vibedating like <id>`) and via **MCP tools**, so you can run it inside whatever
  agent/terminal you use — Claude Code, Codex, Cursor, etc.
- One local engine, three faces (web / CLI / MCP), same as the rest of the suite.

## Verification (the whole mechanic depends on the number being real)
- **Read-only OAuth usage scope** is the ideal: confirm the account is a genuine
  Claude Code/Codex/etc subscription AND that the usage is that account's own —
  **without handing over full credentials or passwords.** Never a pasted number.
- Where a provider exposes no OAuth usage scope: fall back to a signed local attest
  (the CLI reads local usage telemetry the harness already stores, signs it) — weaker,
  flagged as "self-reported", visually distinct from OAuth-verified.
- Cross-harness usage-read is a `@vibe/core` §4b host-adapter concern (each adapter
  knows how to read that harness's usage).

## Privacy (raw usage can leak what you worked on)
- **Raw token counts stay local.** Only the **league bucket** is shared — never raw
  numbers, never per-project/per-repo breakdowns.
- Consent ledger gates any share; "show raw usage" is local-only, opt-in per view.
- Derived, non-identifying traits (e.g. "night-shift committer") only if the user
  opts in.

## Matching / leagues
- Bucket by lifetime (or rolling-window) tokens; match within league.
- **Pool thinness at the top** (1B+ is tiny): widen adjacent leagues as tokens climb,
  or bridge the top two tiers so 1B+ users still have a pool. Thresholds tunable.
- Standard like/pass; mutual like within-league = match.

## Surfaces
- **CLI:** `vibedating connect` (OAuth) · `vibedating open` (local web UI) ·
  `vibedating matches` · `vibedating like/pass <id>`.
- **npm:** `getUsage()`, `league(usage)`, match client.
- **MCP:** `vibedating.profile`, `vibedating.matches`, `vibedating.like` — usable
  from inside the agent.
- **Backend reality check:** unlike the other five, matching needs a *shared
  directory* of profiles → a minimal server holds only `{handle, league,
  verified, opt-in traits}`, never raw usage. This is the one product with an
  unavoidable central component; keep what it stores minimal + user-controlled.

## Open questions (lean hard on these per original brief)
- Verification without full creds: depends on each provider exposing a read-only
  usage scope — may not exist yet; self-attest fallback is weaker. Which providers
  actually offer this? (research task).
- What the central directory stores + retention + deletion — minimize, encrypt,
  user-deletable.
- League thresholds vs pool density — needs real usage distribution data to set.
- Adjacent to existing `vibescore` (leaderboards/velocity) — reuse its league math?
  Check before rebuilding.
