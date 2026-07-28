/**
 * Pure unit tests for the room topic derivation (no network).
 *
 * The 3-node mesh behavior (roster + broadcast) lives in room.integration.test.ts
 * — it drives real hyperswarm sockets on an isolated in-process DHT.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ROOM_TOPIC_PREFIX, roomTopic } from './room.js';
import { leagueTopic, TOPIC_PREFIX } from './p2p.js';

describe('roomTopic', () => {
  it('is deterministic: same name → same 32-byte topic', () => {
    expect(roomTopic('den')).toEqual(roomTopic('den'));
    expect(roomTopic('den')).toHaveLength(32);
  });

  it('different names → different topics', () => {
    expect(roomTopic('den')).not.toEqual(roomTopic('lounge'));
  });

  it('is sha256("vibedate-room:" + name) — the documented derivation', () => {
    const name = 'den';
    expect(roomTopic(name)).toEqual(
      createHash('sha256').update(`${ROOM_TOPIC_PREFIX}${name}`, 'utf8').digest(),
    );
  });

  it('never collides with a league topic (disjoint namespaces)', () => {
    // A room named "10M" must NOT hash to the 10M league topic — the prefixes
    // differ, so room discovery and 1:1 league discovery are fully separate.
    expect(roomTopic('10M')).not.toEqual(leagueTopic('10M'));
    expect(ROOM_TOPIC_PREFIX).not.toBe(TOPIC_PREFIX);
  });
});
