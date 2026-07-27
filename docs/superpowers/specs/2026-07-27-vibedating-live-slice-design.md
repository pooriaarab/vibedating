# vibedating — live session design (increment 1: text chat + "next" loop)

Date: 2026-07-27
Status: approved design, pre-implementation
Repo: pooriaarab/vibedating · depends on `@pooriaarab/vibe-core`

## Context

Shipped v0 (`@pooriaarab/vibedating@0.1.0`) is **async token-league matching**:
read your Claude/Codex usage → league bucket (1M/5M/10M/100M/1B+) → browse
candidates in your league. CLI + MCP + local web app.

`main` already went further than the v0 README: `src/p2p.ts` adds **live P2P
discovery over the hyperswarm DHT** — same-league peers find each other on the
public DHT with **no server**, Noise-encrypted, NAT hole-punched, sharing only
`{handle, league, harness}` (allowlist parser drops raw usage), consent-gated
behind `share:live`.

The product vision: expand toward a **verified-coders-only live community** —
"omegle for AI coders" — text → images/video → livestreams, plus the existing
async dating mode. Both modes over one spine.

## Decisions (locked with user)

1. **Two front doors, one spine.** Async league dating (shipped) + live
   omegle-style pairing (new) are different *entry policies* into the same
   live session layer. Build the layer once.
2. **Verified-coders-only.** Verification is both the moat and the safety gate:
   pseudonymous-but-verified, not anonymous. This sidesteps Omegle's fatal
   flaw (anonymous abuse) by design. (Full verification = increment 3.)
3. **No hosting. P2P mesh.** Discovery + transport are peer-to-peer over the
   hyperswarm DHT — no signaling server we run. Public DHT bootstrap + NAT
   hole-punching are public commons, not our infrastructure. Content is
   end-to-end encrypted and never touches a server because there is no server.
4. **Media/video is in scope** — deferred to increment 2, not cut. Transport is
   chosen so A/V rides the same peer connection.

## What already exists (reuse, do not rebuild)

`src/p2p.ts`:
- `leagueTopic(league)` → deterministic 32-byte DHT topic. Discovery mechanism.
- `startDiscovery(opts)` → joins the swarm, handshakes every same-league peer
  over an **encrypted socket**, records peers locally, fires a best-effort
  vibe-core `match` notification on each new peer. Returns a live `peers` map +
  `close()`.
- `PeerHello` allowlist (`handle`/`league`/`harness`) + hardened
  `parseHandshake` (caps, drops unknown keys) = the privacy invariant.
- Consent gate lives with the caller (CLI gates on `share:live`).

**The gap:** peers connect and exchange hello, then stop. There is no message
channel — they cannot talk. Increment 1 fills exactly that gap.

## Increment 1 — the slice: live text chat + "next" loop

### Goal
Two same-league peers, discovered via the existing DHT layer, exchange **text**
in real time over the socket that `startDiscovery` already opens, with an
omegle-style **`next`** to drop the current peer and reroll to another
same-league peer. No new transport, no media yet, verification still stubbed
(`verified: true` mocked, league self-supplied). Zero hosting.

### Design
The `socket` in `startDiscovery`'s `connection` handler is already an
encrypted, framed, newline-delimited JSON stream. Extend that framing from a
one-shot hello into a small typed message protocol:

```
{ t: "hello", handle, league, harness }        // existing, sent first
{ t: "msg",   id, text, at }                    // new: a chat line
{ t: "typing" }                                 // optional presence
{ t: "bye" }                                     // graceful "next"/close
```

- **Session object** wraps one peer connection: `send(text)`, `onMessage`,
  `onClose`, `close()` (sends `bye`, drops socket). Built on the existing
  socket — no new dependency.
- **Pairing policy** (the "front door") is a thin layer over the `peers` map:
  - *omegle mode:* auto-select one connected same-league peer as the active
    session; `next` closes it and picks the next available peer, rerolling
    discovery if the pool is empty.
  - *dating mode:* user picks a specific handle from the roster to open a
    session (async browse unchanged; this just adds "message" to a match).
- **Parser hardening carries over:** same allowlist discipline — `msg` capped
  in length, unknown `t` dropped, malformed lines ignored (reuse the
  `parseHandshake` pattern for a `parseFrame`).

### Surfaces
- **CLI:** `vibedating live` — join, auto-pair, chat in the terminal, `/next`,
  `/quit`. Prints `LIVE_NOTICE` + consent gate before joining.
- **MCP:** a `live_session` tool pair (start/send/next) so an agent can drive it.
- **Local web app:** chat pane over the existing served UI (`server.ts` +
  `web-app-html.ts`), talking to the local session over the existing local IPC.

### Out of scope for the slice
Media/video (incr 2), real verification (incr 3), report/block/ban (incr 4),
message persistence/history beyond the session, group rooms.

### Test plan
- Unit: `parseFrame` allowlist/caps (reuse `parseHandshake` test shape); session
  send/receive/close state machine.
- Integration: two `startDiscovery` sessions on a **local testnet DHT** (the
  existing `bootstrap` injection + `randomTopic` already support this) exchange
  messages and `next` cleanly — extends `p2p.integration.test.ts`.
- One `assert`-based self-check that a `bye` frame closes both ends.

## Increment 2 — media/video (in scope, next)
- Images/files: chunked over the data stream with backpressure + a size cap.
- Live A/V: negotiate a **WebRTC** peer connection **using the hyperswarm socket
  as the signaling channel** (SDP/ICE frames as new `t:` types); RTP media then
  flows P2P. WebRTC gives real jitter buffer, codecs, congestion control that a
  raw stream does not. Reuses discovery + the increment-1 framing as signaling.

## Increment 3 — verification moat (feasibility research first)
The least-certain-feasible piece: prove an account is real **and** the usage is
that account's own, without full credentials. Candidate mechanisms — read-only
OAuth usage scope (does it exist per provider?), signed local-usage attestation,
provider-session read. Needs a research pass before its own spec. `verified`
seam already exists (`tryReadVerifiedUsage`).

## Increment 4 — safety
report/block/ban + reputation, keyed on the stable verified handle from incr 3.
Even a verified community needs it; scoped once identity is real.

## Risks / open questions
- **Verification feasibility** (incr 3) is the product's biggest unknown — the
  moat may need a weaker proof than "read-only OAuth usage" if no provider
  exposes one. Does not block increments 1–2.
- **Pool thinness:** high leagues (1B+) may have too few live peers to pair.
  Mitigation: adjacent-league fallback (topic set), already conceptually
  supported by league bucketing.
- **NAT edge cases:** hyperdht hole-punching covers most, but symmetric-NAT
  pairs may fail to connect — acceptable for the slice, revisit if common.

## Reuse ledger
`@pooriaarab/vibe-core` (cascade, `notify`, consent) · hyperswarm/hyperdht
(DHT discovery, Noise, NAT) · existing `p2p.ts` socket + allowlist · existing
`server.ts`/`web-app-html.ts` for the web surface. New code: message framing +
session object + pairing policy + CLI/MCP/web wiring. No new heavy dependency
for the slice.
