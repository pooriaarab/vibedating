import { describe, expect, it, vi } from 'vitest';
import { createPairing } from './pairing.js';
import type { PeerLink } from './link.js';

/**
 * A fake PeerLink for pairing tests: spies on send/close, captures the onClose
 * callback so a test can simulate a REMOTE hang-up (matching real PeerLink
 * semantics, where a local close() never fires our own onClose).
 */
interface FakeLink extends PeerLink {
  fireRemoteClose(): void;
  fireMessage(text: string): void;
}

function fakeLink(handle: string): FakeLink {
  let closeCb: (() => void) | undefined;
  let msgCb: ((m: { id: string; text: string; at: number }) => void) | undefined;
  let isClosed = false;
  return {
    hello: { handle, league: '10M', harness: 'fake' },
    get closed() { return isClosed; },
    send: vi.fn(),
    sendMedia: vi.fn().mockResolvedValue({ id: '', size: 0 }),
    sendSignal: vi.fn(),
    onMessage: (cb) => {
      msgCb = cb;
    },
    onMedia: vi.fn(),
    onSignal: vi.fn(),
    onClose: (cb: () => void) => {
      closeCb = cb;
    },
    close: vi.fn(() => { isClosed = true; }),
    fireRemoteClose: () => { isClosed = true; closeCb?.(); },
    fireMessage: (text: string) => msgCb?.({ id: text, text, at: 1 }),
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

  it('caps queue at MAX_QUEUE and drops oldest', () => {
    const pairing = createPairing();
    const links = Array.from({ length: 102 }, (_, i) => fakeLink(`@peer${i}`));
    for (const l of links) pairing.add(l);
    
    // First link is current
    expect(pairing.current()?.hello.handle).toBe('@peer0');
    // Queue should have 100 links (101 added, 1 dropped)
    expect(pairing.available).toBe(100);
    expect(links[1]!.close).toHaveBeenCalledTimes(1); // @peer1 dropped
    expect(links[2]!.close).not.toHaveBeenCalled();
  });

  it('next() skips a closed link in the queue', () => {
    const pairing = createPairing();
    const a = fakeLink('@alice');
    const b = fakeLink('@bob');
    const c = fakeLink('@carol');
    
    pairing.add(a); // current
    pairing.add(b); // queued
    pairing.add(c); // queued
    
    // Mark b as closed remotely without triggering onClose just to test next() logic
    Object.defineProperty(b, 'closed', { get: () => true });
    
    pairing.next(); // Should skip b and select c
    expect(pairing.current()).toBe(c);
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

describe('LivePairing — message routing (bind once, buffer non-current)', () => {
  it('buffers a non-current peer message instead of dropping it, flushes on select', () => {
    const pairing = createPairing();
    const delivered: Array<[string, string]> = [];
    const queued: Array<[string, number]> = [];
    pairing.onMessage((from, m) => delivered.push([from, m.text]));
    pairing.onQueued((from, n) => queued.push([from, n]));

    const alice = fakeLink('@alice');
    const bob = fakeLink('@bob');
    pairing.add(alice); // auto-paired → current
    pairing.add(bob); // queued

    alice.fireMessage('hi from alice'); // current → delivered live
    bob.fireMessage('hi from bob'); // non-current → BUFFERED, not dropped

    expect(delivered).toEqual([['@alice', 'hi from alice']]);
    expect(queued).toEqual([['@bob', 1]]);

    pairing.open('@bob'); // select bob → flush his buffer
    expect(delivered).toEqual([
      ['@alice', 'hi from alice'],
      ['@bob', 'hi from bob'], // flushed on select, never lost
    ]);
  });

  it('delivers a current-peer message exactly once (onMessage bound once per link)', () => {
    const pairing = createPairing();
    const delivered: string[] = [];
    pairing.onMessage((_from, m) => delivered.push(m.text));
    const alice = fakeLink('@alice');
    pairing.add(alice);
    alice.fireMessage('one');
    alice.fireMessage('two');
    expect(delivered).toEqual(['one', 'two']); // once each — no duplication
  });
});
