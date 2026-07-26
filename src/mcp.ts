/**
 * vibedating MCP server (stdio). Exposes two tools to the agent:
 *
 *   - `profile` — your league (computed locally from your usage; raw usage never
 *     leaves the machine).
 *   - `matches` — candidates in your league (same or adjacent tier).
 *
 * Both read the local profile written by `vibedating connect`. If you haven't
 * connected, they tell the agent to run `connect` first. No network, no egress.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CANDIDATES, matches } from './index.js';
import { loadProfile } from './state.js';

/** A single MCP text content block, narrowly typed for the SDK's union. */
type TextBlock = { readonly type: 'text'; readonly text: string };

function textBlock(text: string): TextBlock {
  return { type: 'text', text };
}

const VERSION = '0.1.0';

/**
 * Start the stdio MCP server. Resolves once connected to the transport; the
 * transport then keeps the process alive for the host agent to call tools.
 */
export async function runMcp(): Promise<void> {
  const mcp = new McpServer({ name: 'vibedating', version: VERSION });

  mcp.tool(
    'profile',
    'Your vibedating league, computed locally from your token usage. Raw usage never leaves the machine — only the league bucket is shared. Requires `vibedating connect` to have run.',
    () => {
      const p = loadProfile();
      if (!p) {
        return {
          content: [
            textBlock('Not connected. Run `vibedating connect` first to compute your league.'),
          ],
        };
      }
      const lines = [
        `handle: ${p.handle}`,
        `harness: ${p.harness}`,
        `league: ${p.league} League`,
        `verified: ${p.verified ? 'true (read-only OAuth)' : 'false (self-reported)'}`,
        'privacy: raw token usage is local-only; only the league bucket is shared.',
      ];
      return { content: [textBlock(lines.join('\n'))] };
    },
  );

  mcp.tool(
    'matches',
    'Candidates in your league (same or adjacent tier) from the local seeded demo pool. No central directory in v0.',
    () => {
      const p = loadProfile();
      if (!p) {
        return {
          content: [textBlock('Not connected. Run `vibedating connect` first.')],
        };
      }
      const list = matches(p.league, CANDIDATES);
      if (list.length === 0) {
        return { content: [textBlock(`No candidates in range for the ${p.league} League.`)] };
      }
      const body = [`Matches for ${p.league} League (${list.length}):`];
      for (const c of list) body.push(`- ${c.handle} (${c.league} League)`);
      return { content: [textBlock(body.join('\n'))] };
    },
  );

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
}
