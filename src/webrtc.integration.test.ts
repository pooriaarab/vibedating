/**
 * Live VIDEO end-to-end integration test — the key deliverable.
 *
 * Two real hyperswarm nodes on an isolated in-process DHT (hyperdht's
 * createTestnet — the public DHT is never touched). On EACH side a real
 * `werift` RTCPeerConnection is created, and its signaling is bridged through
 * the vibedate PeerLink — i.e. the EXACT same `rtc-offer` / `rtc-answer` /
 * `rtc-ice` frames the browser path uses (frame.ts allowlist + PeerLink
 * sendSignal / onSignal). werift stands in for the browser's native
 * RTCPeerConnection in the test core only; production live A/V stays
 * browser-native (werift is a devDependency, never a runtime dep).
 *
 * The offerer adds a synthetic video track. This test asserts the FULL chain:
 *   1. signaling relay over the P2P socket,
 *   2. WebRTC negotiation (SDP offer/answer + trickled ICE) reaches
 *      connectionState 'connected' / iceConnectionState 'connected',
 *   3. the answerer's `ontrack` fires — a media track is actually received, and
 *   4. real RTP packets written on the offerer's track arrive on the answerer's
 *      received track (onReceiveRtp) — media genuinely flows.
 *
 * No unit test (which fakes the socket) and no signaling-only relay test (which
 * ships no real SDP / no real media) can substitute for this: it is the
 * multi-machine proof that live A/V over P2P signaling actually works.
 *
 * NOTE on a werift quirk: unlike browsers, werift's `addIceCandidate` REJECTS a
 * non-empty candidate that carries no `sdpMid` / `sdpMLineIndex`. The browser
 * path sends the candidate line alone and the browser auto-derives the m-line;
 * werift does not. Because the protocol's `rtc-ice` frame carries only the
 * candidate string (and an empty string = end-of-gathering marker — see
 * frame.ts), the RECEIVER reconstructs `{candidate, sdpMLineIndex: 0}` before
 * handing it to werift. There is a single bundled video m-line, so m-line 0 is
 * always correct. This is a test-only accommodation; no runtime src is changed.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import createTestnet from 'hyperdht/testnet.js';
import { RTCPeerConnection, RtpHeader, RtpPacket, MediaStreamTrack } from 'werift';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  randomTopic,
  startDiscovery,
  type DiscoverySession,
  type PeerHello,
} from './p2p.js';
import type { RtcFrame } from './frame.js';
import type { PeerLink } from './link.js';

const ALICE: PeerHello = { handle: '@alice_10M', league: '10M', harness: 'claude-code' };
const BOB: PeerHello = { handle: '@bob_10M', league: '10M', harness: 'codex' };

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return cond();
}

describe('live video e2e (real werift RTCPeerConnection over P2P signaling)', () => {
  let testnet: Awaited<ReturnType<typeof createTestnet>>;
  let dirs: string[];
  let sessions: DiscoverySession[];
  let pcs: RTCPeerConnection[];

  beforeEach(async () => {
    testnet = await createTestnet(3);
    dirs = [];
    sessions = [];
    pcs = [];
  }, 30_000);

  afterEach(async () => {
    for (const pc of pcs) {
      try {
        await pc.close();
      } catch {
        /* already closed */
      }
    }
    for (const s of sessions) await s.close();
    await testnet.destroy();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }, 30_000);

  function tmpDir(): string {
    const d = mkdtempSync(path.join(os.tmpdir(), 'vibedating-webrtc-'));
    dirs.push(d);
    return d;
  }

  /** spawn + onLink: a discovery node that also captures each live PeerLink. */
  async function spawnWithLink(
    hello: PeerHello,
    topic: Buffer,
    onLink: (link: PeerLink) => void,
  ): Promise<DiscoverySession> {
    const session = await startDiscovery({
      hello,
      topic,
      bootstrap: testnet.bootstrap,
      stateDir: tmpDir(),
      onLink,
    });
    sessions.push(session);
    return session;
  }

  it('offerer video track → answerer ontrack + connectionState connected + real RTP arrives', async () => {
    const topic = randomTopic();
    let linkA: PeerLink | undefined;
    let linkB: PeerLink | undefined;

    const a = await spawnWithLink(ALICE, topic, (l) => {
      linkA = l;
    });
    const b = await spawnWithLink(BOB, topic, (l) => {
      linkB = l;
    });
    await Promise.all([a.ready, b.ready]);

    // Both PeerLinks must exist before any signaling — the negotiation below
    // assumes onSignal handlers can be registered on both sides up front.
    expect(await waitFor(() => !!linkA && !!linkB, 40_000)).toBe(true);

    // ── Real werift RTCPeerConnections: host candidates only, no STUN. ───────
    const pcA = new RTCPeerConnection({ iceServers: [] });
    const pcB = new RTCPeerConnection({ iceServers: [] });
    pcs.push(pcA, pcB);

    // Track the states the assertions care about.
    let aIceConnected = false;
    let bConnected = false;
    pcA.iceConnectionStateChange.subscribe((s) => {
      if (s === 'connected' || s === 'completed') aIceConnected = true;
    });
    pcB.connectionStateChange.subscribe((s) => {
      if (s === 'connected') bConnected = true;
    });

    // The answerer's received media: ontrack gives us the (remote) track; its
    // onReceiveRtp fires when actual RTP packets arrive over the media path.
    let receivedTrack: MediaStreamTrack | undefined;
    let rtpReceived = 0;
    pcB.ontrack = (ev) => {
      receivedTrack = ev.track;
      ev.track.onReceiveRtp.subscribe(() => {
        rtpReceived++;
      });
    };

    // ── Bridge signaling through the vibedate PeerLink (the rtc-* frames). ──
    // Trickle ICE: every locally-gathered candidate is relayed as an rtc-ice
    // frame over the P2P socket (empty string = end-of-gathering marker).
    pcA.onIceCandidate.subscribe((c) => {
      linkA?.sendSignal({ t: 'rtc-ice', candidate: c ? c.candidate : '' });
    });
    pcB.onIceCandidate.subscribe((c) => {
      linkB?.sendSignal({ t: 'rtc-ice', candidate: c ? c.candidate : '' });
    });

    // A is the offerer; it only ever receives an rtc-answer + rtc-ice.
    linkA!.onSignal(async (f: RtcFrame) => {
      if (f.t === 'rtc-answer') {
        await pcA.setRemoteDescription({ type: 'answer', sdp: f.sdp });
      } else if (f.t === 'rtc-ice') {
        try {
          await pcA.addIceCandidate(f.candidate === '' ? null : { candidate: f.candidate, sdpMLineIndex: 0 });
        } catch {
          /* late / duplicate candidate — harmless */
        }
      }
    });

    // B is the answerer: on the offer it completes its local description and
    // replies; it also consumes A's trickled ICE candidates.
    linkB!.onSignal(async (f: RtcFrame) => {
      if (f.t === 'rtc-offer') {
        await pcB.setRemoteDescription({ type: 'offer', sdp: f.sdp });
        const answer = await pcB.createAnswer();
        await pcB.setLocalDescription(answer);
        linkB!.sendSignal({ t: 'rtc-answer', sdp: answer.sdp });
      } else if (f.t === 'rtc-ice') {
        try {
          await pcB.addIceCandidate(f.candidate === '' ? null : { candidate: f.candidate, sdpMLineIndex: 0 });
        } catch {
          /* late / duplicate candidate — harmless */
        }
      }
    });

    // ── A adds a synthetic video track, then initiates negotiation. ─────────
    const videoTrack = new MediaStreamTrack({ kind: 'video' });
    pcA.addTrack(videoTrack);

    const offer = await pcA.createOffer();
    await pcA.setLocalDescription(offer); // triggers ICE gathering → rtc-ice frames
    linkA!.sendSignal({ t: 'rtc-offer', sdp: offer.sdp });

    // ASSERTION 1 + 2: negotiation reaches a connected media transport, AND the
    // answerer's ontrack fired (a media track was actually received).
    expect(await waitFor(() => aIceConnected && bConnected && !!receivedTrack, 40_000)).toBe(true);
    expect(pcB.connectionState).toBe('connected');
    expect(pcA.iceConnectionState === 'connected' || pcA.iceConnectionState === 'completed').toBe(true);
    expect(receivedTrack!.kind).toBe('video');

    // ASSERTION 3: real RTP flows over the negotiated media path — write a
    // burst of packets on the offerer's track and watch them arrive on the
    // answerer's received track. This proves media genuinely travels, not just
    // that the transports connected.
    const header = new RtpHeader({ payloadType: 96, sequenceNumber: 1, timestamp: 160, ssrc: 0xabcdef01 });
    const payload = Buffer.from('vibedate-live-video-rtp-probe-payload');
    for (let i = 0; i < 60; i++) {
      header.sequenceNumber = (i + 1) & 0xffff;
      try {
        videoTrack.writeRtp(new RtpPacket(header, payload));
      } catch {
        /* transport momentarily not ready — keep bursting */
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(await waitFor(() => rtpReceived > 0, 40_000)).toBe(true);
    expect(rtpReceived).toBeGreaterThan(0);
  }, 150_000);
});
