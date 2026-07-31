# WORKER BRIEF — vibedating: import shared primitives from vibe-core@0.6.0

Branch `feat/import-primitives-from-core`. `@pooriaarab/vibe-core@0.6.0` now exports the primitives that
were EXTRACTED FROM THIS REPO (vibedating is the canonical source), so the hoisted code is byte-identical
to your local copies. Replace the local copies with imports. Commit AFTER EACH module. Do NOT push.

## Goal
Delete the duplicated local modules, import the same symbols from vibe-core subpaths. Behaviour MUST be
byte-identical — signatures, DHT topics, frame encoding, chunk format unchanged (live peers must still
interoperate). This is a move, not a redesign.

## Steps (commit each)
1. Bump `@pooriaarab/vibe-core` -> `^0.6.0`, `npm install`.
2. **sanitizePeerText**: delete `src/untrusted.ts`, import from `@pooriaarab/vibe-core/untrusted`.
3. **handle gen**: delete `src/handlegen.ts`, import from `@pooriaarab/vibe-core/handle` (adjust the
   exported name if it differs; keep call sites working).
4. **identity (ed25519)**: the crypto moved to `@pooriaarab/vibe-core/identity`, but the CLAIMS STRING is
   now a parameter. vibe-core exports `loadOrCreateIdentity`, `signClaims`/`verifyClaims` (opaque string)
   and `joinClaims`/`signClaimFields`. Replace `src/identity.ts`'s ed25519 mechanism with these; KEEP
   vibedating's `canonicalHelloClaims` (the `handle|league|harness|verified|nonce` field order) LOCAL and
   feed it in, so signatures stay byte-identical. Also KEEP any secp256k1 / NIP-04 key code LOCAL (it was
   never hoisted). Verify a sig made by the OLD code still verifies (same claims string + ed25519).
5. **frame**: delete the parser-combinator MECHANISM from `src/frame.ts`, import it from
   `@pooriaarab/vibe-core/frame`. KEEP vibedating's concrete frame UNION types (chat/media/rtc) local --
   they are policy; pass them to the combinator.
6. **media**: delete `src/media.ts`, import the chunked-transfer mechanism from `@pooriaarab/vibe-core/media`.
7. **link (PeerLink)**: the generic PeerLink is `@pooriaarab/vibe-core/link` (wraps an injected Duplex +
   an app frame codec). Replace `src/link.ts` with a thin local wrapper that constructs it with
   vibedating's frame types + the hyperswarm socket. KEEP `src/p2p.ts` (hyperswarm discovery) LOCAL and
   inject its socket into the vibe-core PeerLink.
8. **topic/id helpers**: where `src/p2p.ts` derives the DHT topic, use `topicFor(namespace, name)` from
   `@pooriaarab/vibe-core/ids` -- it returns the RAW 32-byte Buffer, byte-identical to the old
   `sha256(prefix+name).digest()`. Same for any `newId`/`newToken`.
9. `grep -rE "from '\.\.?/(untrusted|handlegen|frame|media|link)'" src` should return nothing (identity
   partly stays local for the claims/nostr policy -- that's fine).
10. Bump vibedating to the next patch/minor.

## Rules
- BYTE-COMPAT is the hard requirement -- do NOT change any wire/crypto value. If a vibe-core export differs
  subtly from the local version, adapt the call site, never fork the mechanism.
- `npm run typecheck` clean, `npm test` green (the full existing suite -- that's the byte-compat guard),
  `npm run build` clean.
- Do NOT touch hyperswarm p2p discovery logic, nostr keys, frame union types, or profile state -- those
  stay local (policy).

## Done =
local untrusted/handlegen/frame/media/link deleted + imported from vibe-core; identity uses vibe-core's
ed25519 with local claims; p2p.ts keeps hyperswarm + injects the socket; grep clean; typecheck + FULL
test suite + build green (byte-compat proven by the passing suite); committed incrementally. Print what
moved, what stayed local + why, and the final test count.
