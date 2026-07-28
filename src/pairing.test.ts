import { describe, expect, it, vi } from 'vitest';
import { createPairing } from './pairing.js';
import type { PeerLink } from './link.js';

/**
 * A fake PeerLink for pairing tests: spies on send/close, captures the onClose
 * callback so a test can simulate a REMOTE hang-up (matching real PeerLink
 * semantics, where a local close() never fires our own onClose). Also captures
 * onMessage so tests can inject inbound chat (exercising drain/onMessage/onQueued).
 */
interface FakeLink extends PeerLink {
  fireRemoteClose(): void;
  fireMessage(text: string, id?: string): void;
}

function fakeLink(handle: string): FakeLink {
  let closeCb: (() => void) | undefined;
  const messageCbs = new Set<(m: { id: string; text: string; at: number }) => void>();
  return {
    hello: { handle, league: '10M', harness: 'fake' },
    send: vi.fn(),
    sendMedia: vi.fn().mockResolvedValue({ id: '', size: 0 }),
    sendSignal: vi.fn(),
    onMessage: (cb: (m: { id: string; text: string; at: number }) => void) => {
      messageCbs.add(cb);
    },
    onMedia: vi.fn(),
    onSignal: vi.fn(),
    onClose: (cb: () => void) => {
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

describe('LivePairing — omegle auto-pair + next', () => {
  it('auto-pairs the first arriving link', () => {
    const pairing = createPairing();
    const onMatch = vi.fn();
    pairing.onMatch(onMatch);
    const a = fakeLink('@alice');
    pairing.add(a);

    expect(pairing.current()).toBe(a);
    expect(onMatch).toHaveBeenCalledTimes(1);
    expect(onMatch).toHaveBeenCalledWith(a);
  });

  it('queues extra links while a match is active', () => {
    const pairing = createPairing();
    const a = fakeLink('@alice');
    const b = fakeLink('@bob');
    pairing.add(a);
    pairing.add(b);

    expect(pairing.current()).toBe(a);
    expect(pairing.available).toBe(1);
  });

  it('next() closes the current link and advances to the next available', () => {
    const pairing = createPairing();
    const a = fakeLink('@alice');
    const b = fakeLink('@bob');
    pairing.add(a); // current
    pairing.add(b); // queued

    const onMatch = vi.fn();
    pairing.onMatch(onMatch);
    const now = pairing.next();

    expect(a.close).toHaveBeenCalledTimes(1); // prior match closed
    expect(now).toBe(b);
    expect(pairing.current()).toBe(b);
    expect(pairing.available).toBe(0);
    expect(onMatch).toHaveBeenCalledWith(b);
  });

  it('next() with no waiting link goes idle (current undefined)', () => {
    const pairing = createPairing();
    const a = fakeLink('@alice');
    pairing.add(a);

    const onMatch = vi.fn();
    pairing.onMatch(onMatch);
    const now = pairing.next();

    expect(a.close).toHaveBeenCalledTimes(1);
    expect(now).toBeUndefined();
    expect(pairing.current()).toBeUndefined();
    expect(onMatch).toHaveBeenCalledWith(undefined);
  });

  it('re-pairs when a link arrives while idle after next()', () => {
    const pairing = createPairing();
    const a = fakeLink('@alice');
    pairing.add(a);
    pairing.next(); // idle now

    const onMatch = vi.fn();
    pairing.onMatch(onMatch);
    const b = fakeLink('@bob');
    pairing.add(b);

    expect(pairing.current()).toBe(b);
    expect(onMatch).toHaveBeenCalledWith(b);
  });
});

describe('LivePairing — dating open(handle)', () => {
  it('picks the available link whose handle matches', () => {
    const pairing = createPairing();
    const a = fakeLink('@alice');
    const bob = fakeLink('@bob');
    const carol = fakeLink('@carol');
    pairing.add(a); // current
    pairing.add(bob); // queued
    pairing.add(carol); // queued

    const got = pairing.open('@carol');

    expect(got).toBe(carol);
    expect(pairing.current()).toBe(carol);
    expect(a.close).toHaveBeenCalledTimes(1); // prior match closed on switch
    expect(pairing.available).toBe(1); // bob still waiting
  });

  it('returns undefined for an unknown handle and leaves the current match alone', () => {
    const pairing = createPairing();
    const a = fakeLink('@alice');
    pairing.add(a);

    const got = pairing.open('@nobody');

    expect(got).toBeUndefined();
    expect(pairing.current()).toBe(a);
    expect(a.close).not.toHaveBeenCalled();
  });
});

describe('LivePairing — message buffer (agent-native poll)', () => {
  it('buffers current-peer messages for drain() and fires onMessage', () => {
    const pairing = createPairing();
    const onMessage = vi.fn();
    const onQueued = vi.fn();
    pairing.onMessage(onMessage);
    pairing.onQueued(onQueued);
    const a = fakeLink('@alice');
    pairing.add(a);

    a.fireMessage('hello from alice', 'm1');

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0]![0]).toMatchObject({
      from: '@alice',
      text: 'hello from alice',
      id: 'm1',
      queued: false,
    });
    expect(onQueued).not.toHaveBeenCalled();

    const drained = pairing.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({ from: '@alice', text: 'hello from alice', queued: false });
    // Second drain is empty.
    expect(pairing.drain()).toEqual([]);
  });

  it('tags queued (non-current) peer messages and fires onQueued', () => {
    const pairing = createPairing();
    const onMessage = vi.fn();
    const onQueued = vi.fn();
    pairing.onMessage(onMessage);
    pairing.onQueued(onQueued);
    const a = fakeLink('@alice');
    const b = fakeLink('@bob');
    pairing.add(a); // current
    pairing.add(b); // queued

    b.fireMessage('psst from bob', 'm2');

    expect(onQueued).toHaveBeenCalledTimes(1);
    expect(onQueued.mock.calls[0]![0]).toMatchObject({
      from: '@bob',
      text: 'psst from bob',
      queued: true,
    });
    expect(onMessage).not.toHaveBeenCalled();

    const drained = pairing.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({ from: '@bob', queued: true });
  });

  it('exposes queued() snapshot in arrival order', () => {
    const pairing = createPairing();
    const a = fakeLink('@alice');
    const b = fakeLink('@bob');
    const c = fakeLink('@carol');
    pairing.add(a);
    pairing.add(b);
    pairing.add(c);
    expect(pairing.queued().map((l) => l.hello.handle)).toEqual(['@bob', '@carol']);
  });
});

describe('LivePairing — remote hang-up handling', () => {
  it('clears current and auto-pairs the next when the current link closes', () => {
    const pairing = createPairing();
    const a = fakeLink('@alice');
    const b = fakeLink('@bob');
    pairing.add(a); // current
    pairing.add(b); // queued

    const onMatch = vi.fn();
    pairing.onMatch(onMatch);
    a.fireRemoteClose(); // peer "next"-ed us

    expect(pairing.current()).toBe(b);
    expect(onMatch).toHaveBeenCalledWith(b);
  });

  it('removes a queued link (not current) when it closes', () => {
    const pairing = createPairing();
    const a = fakeLink('@alice');
    const b = fakeLink('@bob');
    pairing.add(a); // current
    pairing.add(b); // queued

    b.fireRemoteClose();

    expect(pairing.current()).toBe(a); // unchanged
    expect(pairing.available).toBe(0);
  });
});
