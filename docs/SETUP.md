# Setup

How to install vibedate and wire up its MCP server on macOS, Windows, and Linux.

## What you need

- Node.js 18 or newer (`node --version` to check).
- An agentic coding CLI or Claude Desktop, if you want the MCP server.

vibedate is peer-to-peer. There's no account and no server to sign into — two
laptops find each other directly over a DHT.

## Install

You don't have to install anything. `npx` runs the latest published version:

```
npx vibedate connect      # compute your league from local usage
npx vibedate live --any   # start chatting
```

To get a persistent `vibedate` command, install it globally:

```
npm install -g vibedate
```

## MCP setup

The MCP server lets an agent drive vibedate through tool calls instead of an
interactive terminal. Use it if your `live` session keeps timing out — the agent
polls for messages instead of holding a session open.

There are two ways in, and both start the same server:

- the `vibedate mcp` subcommand
- the `vibedate-mcp` binary

### Claude Code (all platforms)

One command, no file editing:

```
# macOS and Linux
claude mcp add vibedate -- npx -y vibedate@latest mcp

# Windows
claude mcp add vibedate -- cmd /c npx -y vibedate@latest mcp
```

### Claude Desktop (editing the config file)

Open the config file, add the `vibedate` block, then fully quit and reopen
Claude.

**macOS** — `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "vibedate": { "command": "npx", "args": ["-y", "vibedate@latest", "mcp"] }
  }
}
```

**Linux** — `~/.config/Claude/claude_desktop_config.json`: same as macOS.

**Windows** — `%APPDATA%\Claude\claude_desktop_config.json` (paste that into the
Explorer address bar, open with Notepad):

```json
{
  "mcpServers": {
    "vibedate": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "vibedate@latest", "mcp"]
    }
  }
}
```

### Two things that break MCP on Windows

Most "MCP failed" or "not connected" reports on Windows come down to one of these.

1. **`"command": "npx"` on its own doesn't work.** Windows can't run `npx`
   directly, so the server never starts. Wrap it: `"command": "cmd"` with
   `"args": ["/c", "npx", ...]`. macOS and Linux don't need this.
2. **A stale cached version.** `npx` caches packages, so it can keep serving an
   old build. `vibedate@latest` forces the current release.

## Video calls behind strict networks (optional)

Most video calls connect directly. If both people are behind a strict (symmetric)
NAT, direct connection can fail and you'll want a TURN relay. Point vibedate at
one with environment variables before running `vibedate open`:

```
export VIBEDATE_TURN_URL="turn:your-turn-server:3478"
export VIBEDATE_TURN_USER="username"      # if your TURN server needs it
export VIBEDATE_TURN_CRED="credential"    # if your TURN server needs it
```

On Windows, set them with `set VIBEDATE_TURN_URL=...` in the same terminal, or
add them to your environment. With nothing set, vibedate uses a public STUN
server, which is enough for most connections.

## Check it works

```
vibedate --version        # prints the version you're running
vibedate connect          # should print your league
```

If the MCP server won't connect, run `npx vibedate@latest mcp` in a terminal on
its own. It should start and wait for input rather than exiting straight away.
