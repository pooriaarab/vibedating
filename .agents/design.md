# Design

## Overview

The shipped surfaces are a local web app, a CLI, and a stdio MCP server.

The web app is defined in `src/web-app-html.ts`. The CLI is defined in `src/cli.ts`.

`src/server.ts` connects the local web app to profile, match, chat, and call behavior.

The repository does not own a custom production deployment. Do not add live routes here.

## Colors

The web app ships one dark palette in `src/web-app-html.ts`.

| Role | Token | Value |
|---|---|---|
| Canvas | `--bg` | `#1a1120` |
| Raised canvas | `--bg-1` | `#22162a` |
| Card | `--bg-card` | `#2a1b33` |
| Card gradient end | `--bg-card-2` | `#31203c` |
| Text | `--fg` | `#f8efe8` |
| Muted text | `--muted` | `#cbb2c4` |
| Secondary text | `--muted-2` | `#a88fae` |
| Action | `--coral` | `#ff7a68` |
| Action shadow | `--coral-dim` | `#e26456` |
| Pending | `--amber` | `#ffb15e` |
| Verified or local | `--mint` | `#7fe3c0` |
| Destructive | `--danger` | `#ff6b6f` |

League tokens are `--lg-1m`, `--lg-5m`, `--lg-10m`, `--lg-100m`, and `--lg-1b`.

Use `--mint` for focus outlines. Do not rely on color without text or a glyph.

The CLI emits text and does not prescribe terminal colors.

## Typography

The web app uses the system sans stack in `src/web-app-html.ts`.

Use its system monospace stack for handles, token values, and code-like content.

Hero text uses weight `800`, tight tracking, and a responsive size clamp.

Panel titles use `1.02rem` at weight `700`. Body text uses compact, readable line heights.

The CLI uses the terminal font. Format totals through `formatTokens` in `src/cli.ts`.

## Layout

The web container stops at `1240px` and uses `24px` side padding.

The main stage uses three columns with a `26px` gap.

At `1020px` and below, it becomes one column with a `620px` width limit.

At `480px` and below, side padding becomes `18px`.

Keep the profile, match stack, and league ladder as distinct panels.

The CLI stays single-column. Indent nested facts and align repeated candidate fields.

## Elevation & Depth

Cards use a `--bg-card` to `--bg-card-2` gradient and a subtle border.

Use `--shadow-1` for small elements, `--shadow-2` for panels, and `--shadow-3` for overlays.

Modal backdrops use a translucent near-black layer and blur. Fixed panels sit above page content.

The CLI uses blank lines and indentation. It has no shadows or stacked surfaces.

## Shapes

Primary cards use `--radius: 20px`. Overlays can use `24px`.

Buttons use `9px` to `13px` radii. Status badges and destructive controls use pill shapes.

Avatars and match actions are circles. Video uses a `4 / 3` aspect ratio.

CLI flags use brackets or angle brackets. Status uses `✓`, `~`, and `🔑` glyphs.

## Components

The top bar contains the wordmark, local-state badge, and current identity chip.

The setup panel contains provider choice, consent, log verification, and profile reveal states.

The match stack contains candidate cards, pass and like actions, and an empty state.

The league ladder shows the five fixed leagues and the current-user marker.

Chat, call, incoming-call, room, and media panels reuse the card palette and depth tokens.

Buttons define hover, active, disabled, and focus-visible states in `src/web-app-html.ts`.

Panel entrances use `rise`. Live dots use `pulse-dot`. Interactive controls use short transitions.

The reduced-motion query shortens every animation and transition to `.001s`.

MCP output is protocol data, not a visual surface. Keep tool names and response fields stable.

## Do's and Don'ts

Do reuse the CSS variables and source components before adding a new token.

Do preserve visible focus, reduced motion, text labels, and responsive behavior.

Do keep verified usage, signed identity, and live status visually distinct.

Don't create a light theme unless the shipped app adds one.

Don't introduce a second palette in `docs/prototype.html` or public media.

Don't add a production URL, `/design.md`, or `/brand` without deployment ownership evidence.
