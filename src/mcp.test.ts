/**
 * MCP server — full agent-native tool surface.
 *
 * Drives the server over an in-memory transport so we never touch stdio or the
 * DHT. Live pairing is injected via hooks: a fake PeerLink that a "peer" can
 * message, proving live_send/live_poll round-trip (including queued non-current).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  createMcpServer,
  createSessionState,
  MCP_TOOL_NAMES,
  type McpSessionState,
} from './mcp.js';
import { createPairing, type LivePairing } from './pairing.js';
import type { PeerLink } from './link.js';
import {
  connectProfile,
  loadBlocklist,
  loadProfile,
  resolveHandle,
  type ProfileState,
} from './state.js';

/* -------------------------------------------------------------------------- */
/* Test harness                                                               */
/* -------------------------------------------------------------------------- */

let stateDir: string;
let prevHome: string | undefined;
let session: McpSessionState;

interface FakeLink extends PeerLink {
  fireMessage(text: string, id?: string): void;
  fireRemoteClose(): void;
}

function fakeLink(handle: string, league = '10M'): FakeLink {
  let closeCb: (() => void) | undefined;
  const messageCbs = new Set<(m: { id: string; text: string; at: number }) => void>();
  return {
    hello: { handle, league, harness: 'fake', verified: true, identityVerified: true },
    send: vi.fn(),
    sendMedia: vi.fn().mockResolvedValue({ id: 'media-1', size: 12 }),
    sendSignal: vi.fn(),
    onMessage: (cb) => {
      messageCbs.add(cb);
    },
    onMedia: vi.fn(),
    onSignal: vi.fn(),
    onClose: (cb) => {
      closeCb = cb;
    },
    close: vi.fn(),
    fireRemoteClose: () => closeCb?.(),
    fireMessage: (text: string, id = `m-${Math.random().toString(36).slice(2, 8)}`) => {
      const m = { id, text, at: Date.now() };
      for (const cb of messageCbs) cb(m);
    },
  };
}

function parseTool(result: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  const block = result.content.find((c) => c.type === 'text');
  expect(block?.text).toBeTypeOf('string');
  return JSON.parse(block!.text!) as Record<string, unknown>;
}

async function withClient(
  hooks: {
    createPairing?: () => LivePairing;
    startLive?: (args: {
      pairing: LivePairing;
      hello: unknown;
      any: boolean;
      to: string | null;
    }) => Promise<{ close: () => Promise<void> } | void> | { close: () => Promise<void> } | void;
  } = {},
): Promise<{
  client: Client;
  close: () => Promise<void>;
  call: (name: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>;
}> {
  session = createSessionState();
  const server = createMcpServer({ session, hooks });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    call: async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      return parseTool(result as { content: Array<{ type: string; text?: string }> });
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function seedProfile(handle = '@tester'): ProfileState {
  // connectProfile writes under defaultStateDir(), which we redirected via HOME.
  return connectProfile(
    {
      harness: 'claude-code',
      totalTokens: 12_000_000,
      verified: true,
    },
    handle,
  );
}

beforeEach(() => {
  stateDir = mkdtempSync(path.join(os.tmpdir(), 'vd-mcp-'));
  prevHome = process.env['HOME'];
  // defaultStateDir() = ~/.vibedating — point HOME at our temp so state is isolated.
  process.env['HOME'] = stateDir;
  // Ensure the vibedating dir exists under the fake home.
  // defaultStateDir uses os.homedir() which reads HOME on unix.
  delete process.env['VIBEDATING_HANDLE'];
});

afterEach(() => {
  if (prevHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = prevHome;
  delete process.env['VIBEDATING_HANDLE'];
  try {
    rmSync(stateDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/* -------------------------------------------------------------------------- */
/* tools/list                                                                 */
/* -------------------------------------------------------------------------- */

describe('MCP tools/list', () => {
  it('exposes the full agent-native tool set', async () => {
    const { client, close } = await withClient();
    try {
      const listed = await client.listTools();
      const names = listed.tools.map((t) => t.name).sort();
      const expected = [...MCP_TOOL_NAMES].sort();
      expect(names).toEqual(expected);
      // Every tool has a non-empty description an agent can understand.
      for (const t of listed.tools) {
        expect(t.description && t.description.length > 20).toBe(true);
      }
    } finally {
      await close();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* State mutations: block / handle_set                                        */
/* -------------------------------------------------------------------------- */

describe('MCP state tools', () => {
  it('handle_set mutates the persisted handle', async () => {
    seedProfile('@old');
    const { call, close } = await withClient();
    try {
      const r = await call('handle_set', { handle: 'newname' });
      expect(r['ok']).toBe(true);
      expect(r['handle']).toBe('@newname');
      expect(resolveHandle()).toBe('@newname');
      expect(loadProfile()?.handle).toBe('@newname');
    } finally {
      await close();
    }
  });

  it('block / unblock mutate the blocklist', async () => {
    seedProfile();
    const { call, close } = await withClient();
    try {
      const blocked = await call('block', { handle: '@spammer' });
      expect(blocked['ok']).toBe(true);
      expect(blocked['changed']).toBe(true);
      expect(loadBlocklist()).toContain('@spammer');

      const list = await call('blocklist');
      expect(list['ok']).toBe(true);
      expect(list['blocked']).toEqual(['@spammer']);

      const unblocked = await call('unblock', { handle: 'spammer' });
      expect(unblocked['ok']).toBe(true);
      expect(unblocked['changed']).toBe(true);
      expect(loadBlocklist()).not.toContain('@spammer');
    } finally {
      await close();
    }
  });

  it('get_profile returns structured profile after connect seed', async () => {
    seedProfile('@agent');
    const { call, close } = await withClient();
    try {
      const r = await call('get_profile');
      expect(r['ok']).toBe(true);
      expect(r['handle']).toBe('@agent');
      expect(r['league']).toBe('10M');
      expect(r['verified']).toBe(true);
    } finally {
      await close();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* live_send / live_poll round-trip over injected fake pairing                */
/* -------------------------------------------------------------------------- */

describe('MCP live chat (injected pairing)', () => {
  it('live_send + live_poll round-trip, including a queued non-current message', async () => {
    seedProfile('@me');

    // Shared pairing the hook will hand the server; we inject two fake peers.
    const pairing = createPairing();
    const alice = fakeLink('@alice');
    const bob = fakeLink('@bob');

    const { call, close } = await withClient({
      createPairing: () => pairing,
      startLive: ({ pairing: p }) => {
        // Auto-add alice (current) + bob (queued) as soon as live starts.
        p.add(alice);
        p.add(bob);
        return { close: async () => undefined };
      },
    });

    try {
      const started = await call('live_start', {});
      expect(started['ok']).toBe(true);
      expect(started['started']).toBe(true);
      expect((started['current'] as { handle: string } | null)?.handle).toBe('@alice');
      expect((started['queued'] as Array<{ handle: string }>).map((q) => q.handle)).toEqual([
        '@bob',
      ]);

      // Send to current (alice).
      const sent = await call('live_send', { text: 'hi alice' });
      expect(sent['ok']).toBe(true);
      expect(sent['to']).toBe('@alice');
      expect(alice.send).toHaveBeenCalledWith('hi alice');

      // Peer messages: current + queued non-current.
      alice.fireMessage('hey back', 'a1');
      bob.fireMessage('pick me', 'b1');

      const polled = await call('live_poll');
      expect(polled['ok']).toBe(true);
      expect(polled['count']).toBe(2);
      const messages = polled['messages'] as Array<{
        from: string;
        text: string;
        queued: boolean;
        id: string;
      }>;
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ from: '@alice', text: 'hey back', queued: false, id: 'a1' }),
          expect.objectContaining({ from: '@bob', text: 'pick me', queued: true, id: 'b1' }),
        ]),
      );

      // Drain is empty on second poll.
      const empty = await call('live_poll');
      expect(empty['count']).toBe(0);

      // live_open promotes bob; live_peers reflects it.
      const opened = await call('live_open', { handle: '@bob' });
      expect(opened['ok']).toBe(true);
      expect((opened['current'] as { handle: string }).handle).toBe('@bob');
      expect(alice.close).toHaveBeenCalled();

      const peers = await call('live_peers');
      expect((peers['current'] as { handle: string }).handle).toBe('@bob');

      await call('live_stop');
      const stopped = await call('live_stop');
      expect(stopped['ok']).toBe(true);
    } finally {
      await close();
    }
  });

  it('live_send fails cleanly when no peer is matched', async () => {
    seedProfile('@me');
    const pairing = createPairing();
    const { call, close } = await withClient({
      createPairing: () => pairing,
      startLive: () => ({ close: async () => undefined }),
    });
    try {
      await call('live_start', {});
      const r = await call('live_send', { text: 'hello?' });
      expect(r['ok']).toBe(false);
      expect(String(r['error'])).toMatch(/no current peer/i);
    } finally {
      await close();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* media_send against an injected current peer                                */
/* -------------------------------------------------------------------------- */

describe('MCP media_send', () => {
  it('sends a file to the current live peer', async () => {
    seedProfile('@me');
    const pairing = createPairing();
    const alice = fakeLink('@alice');
    const filePath = path.join(stateDir, 'pic.txt');
    writeFileSync(filePath, 'hello-bytes');

    const { call, close } = await withClient({
      createPairing: () => pairing,
      startLive: ({ pairing: p }) => {
        p.add(alice);
        return { close: async () => undefined };
      },
    });
    try {
      await call('live_start', {});
      const r = await call('media_send', { handle: '@alice', path: filePath });
      expect(r['ok']).toBe(true);
      expect(r['sent']).toBe(true);
      expect(alice.sendMedia).toHaveBeenCalledWith(filePath);
    } finally {
      await close();
    }
  });
});
