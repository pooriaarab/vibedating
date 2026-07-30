/**
 * The local web app server. Node's built-in `http` only — no new deps.
 *
 * Routes (all localhost, all local data):
 *   GET  /             -> the dating UI (see ./web-app-html.ts)
 *   GET  /api/state    -> { connected, ...profile, candidates: matches }
 *   POST /api/connect  -> read usage, compute + store league, return new state
 *   POST /api/match    -> confirm a same-league match with a candidate; on
 *                         confirmation fires ONE best-effort vibenotify event
 *   GET  /api/live/peers  -> connected live peers (with verification marks)
 *   GET|POST /live/signal -> WebRTC signaling relay (rtc-offer/answer/ice)
 *   GET|POST /live/message -> text chat relay (`msg` frames)
 *                         (the live routes are active only when a LiveBridge is
 *                         attached — see StartServerOptions.live)
 *
 * Raw token usage appears in /api/state so the local page can show it behind an
 * opt-in toggle. It is never sent anywhere off-machine (there is no off-machine).
 *
 * The match notification lives in this endpoint — NOT in the pure `matches()`
 * filter, which runs on every state read and would re-fire constantly. The sink
 * is injectable (`StartServerOptions.notify`) so tests can capture events; it
 * defaults to vibe-core's `notify` (~/.vibe/notify.jsonl).
 */
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeEvent, notify as vibeCoreNotify } from '@pooriaarab/vibe-core';
import type { VibeEvent } from '@pooriaarab/vibe-core';
import type { Candidate } from './index.js';
import { CANDIDATES, matches, readUsage } from './index.js';
import { parseFrame, type RtcFrame } from './frame.js';
import type { PeerLink } from './link.js';
import type { RoomMessage, RoomSession } from './room.js';
import { connectProfile, loadProfile, type ProfileState } from './state.js';
import { sanitizePeerText } from './untrusted.js';
import { webAppHtml } from './web-app-html.js';
import type { ReceivedMedia } from './media.js';

/** Sink for milestone notifications. Injectable so tests can capture events. */
export type NotifySink = (event: VibeEvent) => void;

/* -------------------------------------------------------------------------- */
/* Live A/V signaling bridge (browser <-> local server <-> PeerLink)          */
/* -------------------------------------------------------------------------- */

/** A connected live peer, as the web app needs to see it. */
export interface LivePeerInfo {
  readonly handle: string;
  readonly league: string;
  readonly harness: string;
  /** Self-asserted usage-verification flag from the peer's hello (✓ in the UI). */
  readonly verified?: boolean;
  /** LOCAL-derived: the peer's hello signature verified against its key (🔑). */
  readonly identityVerified?: boolean;
}

/**
 * One text chat message relayed to/from a peer — the payload of a `msg` frame
 * (see frame.ts). `id`/`at` are minted by the SENDER, never by the browser:
 * the browser posts only {handle, text} (see POST /live/message).
 */
export interface LiveMessage {
  readonly id: string;
  readonly text: string;
  readonly at: number;
}

/**
 * Bridge between the browser's WebRTC stack and the P2P {@link PeerLink}s.
 *
 * The browser talks to the local server over HTTP (POST to send, long-poll to
 * receive); the server relays each `rtc-*` frame to/from the matching peer's
 * PeerLink via {@link PeerLink.sendSignal} / {@link PeerLink.onSignal}. Live
 * MEDIA never touches the server — only SDP / ICE strings do. The server is a
 * pure signaling relay; the real RTCPeerConnection lives in the browser, so no
 * native WebRTC dependency is pulled into the CLI.
 *
 * Text chat rides the same bridge: each peer's `msg` frames queue in a
 * per-peer mailbox (drained by the browser's long-poll), and outbound texts go
 * through {@link PeerLink.send}.
 */
export interface LiveBridge {
  /** Snapshot of currently-connected live peers. */
  readonly peers: readonly LivePeerInfo[];
  /** Attach a freshly-handshaken PeerLink (from a discovery session's onLink). */
  addLink(link: PeerLink): void;
  /** Send one rtc-* signaling frame to the peer identified by `handle`. */
  sendSignal(handle: string, frame: RtcFrame): void;
  /** Long-poll for the next incoming rtc-* frame from `handle`. Resolves with
   *  the frame, or null on timeout / when the peer is unknown. */
  pollSignal(handle: string, timeoutMs: number): Promise<RtcFrame | null>;
  /** Send one text message (`msg` frame) to the peer identified by `handle`. */
  sendMessage(handle: string, text: string): void;
  /** Long-poll for the next incoming text message from `handle`. Resolves with
   *  the message, or null on timeout / when the peer is unknown. */
  pollMessage(handle: string, timeoutMs: number): Promise<LiveMessage | null>;
  /** Send media to the peer identified by `handle`. */
  sendMedia(handle: string, path: string): Promise<void>;
  /** Long-poll for incoming media from `handle`. */
  pollMedia(handle: string, timeoutMs: number): Promise<{ name: string; mime: string; dataB64: string } | null>;
}

interface PeerMailbox {
  readonly link: PeerLink;
  /** Incoming rtc-* frames from this peer, drained by the browser long-poll. */
  readonly incoming: RtcFrame[];
  /** Incoming text messages from this peer, drained by the browser long-poll. */
  readonly messages: LiveMessage[];
  /** Incoming media from this peer. */
  readonly media: ReceivedMedia[];
}

/**
 * Cap on queued incoming messages per peer — beyond it the OLDEST are dropped.
 * A chatty peer can't grow memory without bound when the browser never polls.
 * (parseFrame already caps each text at MAX_TEXT_LEN.)
 */
const MAX_QUEUED_MESSAGES = 200;

/** Build a {@link LiveBridge}. Holds no resources of its own; callers attach
 *  PeerLinks from a discovery session via {@link LiveBridge.addLink}. */
export function createLiveBridge(): LiveBridge {
  const boxes = new Map<string, PeerMailbox>();

  const bridge: LiveBridge = {
    get peers(): readonly LivePeerInfo[] {
      // Built field-by-field from the hello — the browser gets exactly the
      // display shape (handle + league + harness + the two verification marks),
      // never identity proof material (pubkey) or anything else the link holds.
      return [...boxes.values()].map((m) => {
        const h = m.link.hello;
        return {
          handle: h.handle,
          league: h.league,
          harness: h.harness,
          ...(h.verified !== undefined ? { verified: h.verified } : {}),
          ...(h.identityVerified !== undefined ? { identityVerified: h.identityVerified } : {}),
        };
      });
    },
    addLink(link) {
      const handle = link.hello.handle;
      boxes.set(handle, { link, incoming: [], messages: [], media: [] });
      // Route every rtc-* frame the peer sends into this peer's mailbox.
      link.onSignal((f) => {
        const mb = boxes.get(handle);
        if (mb) mb.incoming.push(f);
      });
      // Same for text messages, capped (see MAX_QUEUED_MESSAGES).
      link.onMessage((m) => {
        const mb = boxes.get(handle);
        if (!mb) return;
        // input-safety: peer text is UNTRUSTED display data — never executed,
        // never passed to a shell/agent; sanitized at ingress (the web app
        // renders via textContent too — defense in depth).
        mb.messages.push({ ...m, text: sanitizePeerText(m.text) });
        if (mb.messages.length > MAX_QUEUED_MESSAGES) {
          mb.messages.splice(0, mb.messages.length - MAX_QUEUED_MESSAGES);
        }
      });
      link.onMedia((m) => {
        const mb = boxes.get(handle);
        if (!mb) {
          if (!m.error) fs.unlink(m.path, () => {}); // cleanup if peer gone
          return;
        }
        if (m.error) return; // Ignore failed transfers
        mb.media.push({ ...m, name: sanitizePeerText(m.name), mime: sanitizePeerText(m.mime) });
        if (mb.media.length > MAX_QUEUED_MESSAGES) {
          const dropped = mb.media.splice(0, mb.media.length - MAX_QUEUED_MESSAGES);
          for (const d of dropped) fs.unlink(d.path, () => {});
        }
      });
      link.onClose(() => {
        // Only drop the entry if THIS link is still the current one for the
        // handle (a reconnect may have already replaced it).
        const cur = boxes.get(handle);
        if (cur && cur.link === link) boxes.delete(handle);
      });
    },
    sendSignal(handle, frame) {
      boxes.get(handle)?.link.sendSignal(frame);
    },
    async pollSignal(handle, timeoutMs) {
      const mb = boxes.get(handle);
      if (!mb) return null;
      if (mb.incoming.length > 0) return mb.incoming.shift() ?? null;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        const cur = boxes.get(handle);
        if (!cur) return null; // peer vanished mid-poll
        if (cur.incoming.length > 0) return cur.incoming.shift() ?? null;
      }
      return null;
    },
    sendMessage(handle, text) {
      boxes.get(handle)?.link.send(text);
    },
    async pollMessage(handle, timeoutMs) {
      const mb = boxes.get(handle);
      if (!mb) return null;
      if (mb.messages.length > 0) return mb.messages.shift() ?? null;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        const cur = boxes.get(handle);
        if (!cur) return null; // peer vanished mid-poll
        if (cur.messages.length > 0) return cur.messages.shift() ?? null;
      }
      return null;
    },
    async sendMedia(handle, filePath) {
      const mb = boxes.get(handle);
      if (!mb) throw new Error('Peer not found');
      await mb.link.sendMedia(filePath);
    },
    async pollMedia(handle, timeoutMs) {
      const mb = boxes.get(handle);
      if (!mb) return null;
      let targetMedia: ReceivedMedia | null = null;
      if (mb.media.length > 0) {
        targetMedia = mb.media.shift() ?? null;
      } else {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100));
          const cur = boxes.get(handle);
          if (!cur) return null; // peer vanished mid-poll
          if (cur.media.length > 0) {
            targetMedia = cur.media.shift() ?? null;
            break;
          }
        }
      }
      if (!targetMedia) return null;
      try {
        const buf = await fs.promises.readFile(targetMedia.path);
        await fs.promises.unlink(targetMedia.path).catch(() => {});
        return { name: targetMedia.name, mime: targetMedia.mime, dataB64: buf.toString('base64') };
      } catch (err) {
        return null;
      }
    },
  };
  return bridge;
}

/* -------------------------------------------------------------------------- */
/* Room bridge (browser <-> local server <-> RoomSession)                     */
/* -------------------------------------------------------------------------- */

/** Cap on queued rtc-* frames in a room bridge — beyond it the OLDEST are
 *  dropped, so a chatty signaling peer can't grow memory unbounded when the
 *  browser never polls. Mirrors {@link MAX_QUEUED_MESSAGES}. */
const MAX_QUEUED_ROOM_SIGNALS = 200;

/**
 * One queued full-mesh WebRTC signal, already tagged with the sender handle so
 * the browser can route it to the right RTCPeerConnection. The local browser
 * long-polls a single merged mailbox (GET /room/signal?handle=SELF) — unlike
 * 1:1 live signaling which has one mailbox per remote peer.
 */
export interface RoomSignal {
  /** Sender's handle (from the validated hello — UNTRUSTED display data). */
  readonly from: string;
  /** The rtc-offer / rtc-answer / rtc-ice frame payload. */
  readonly rtc: RtcFrame;
}

/**
 * Bridge between the browser and a multi-peer {@link RoomSession}.
 *
 * Mirrors {@link LiveBridge} but for rooms: the browser talks to the local
 * server over HTTP (POST to send, long-poll to receive); the server relays each
 * `rtc-*` frame to/from the matching member's PeerLink via
 * {@link RoomSession.sendSignal} / {@link RoomSession.onSignal}, and relays group
 * chat via {@link RoomSession.broadcast} / {@link RoomSession.onMessage}. Live
 * MEDIA never touches the server — only SDP / ICE strings + text do.
 *
 * The bridge is a SYNCHRONOUS container (created with just the room name, before
 * any session exists) so `cmdOpen` can serve the web app instantly and attach
 * the room session in the background — exactly the pattern {@link createLiveBridge}
 * + `addLink` use. Before {@link RoomBridge.attach}, broadcast/sendSignal no-op
 * and polls queue waiters that fire once the session wires its callbacks.
 */
export interface RoomBridge {
  /** The room name (set at construction, before any session is attached). */
  readonly name: string;
  /** The local member's handle (undefined until a session is attached). */
  readonly self: string | undefined;
  /** Snapshot of currently-connected room members. */
  readonly members: readonly LivePeerInfo[];
  /** Attach a freshly-started {@link RoomSession} (wires onMessage/onSignal). */
  attach(session: RoomSession): void;
  /** Broadcast one text to ALL room members (fan-out via the session). */
  broadcast(text: string): void;
  /** Long-poll for the next incoming group message (merged across members). */
  pollMessage(timeoutMs: number): Promise<RoomMessage | null>;
  /** Send one rtc-* signaling frame to the member identified by `handle`. */
  sendSignal(handle: string, frame: RtcFrame): void;
  /** Long-poll for the next incoming rtc-* frame in the room mesh mailbox.
   *  `handle` is the local SELF handle (the browser's identity); the returned
   *  {@link RoomSignal} carries the *sender* so the mesh can route it. */
  pollSignal(handle: string, timeoutMs: number): Promise<RoomSignal | null>;
}

/** Build a {@link RoomBridge} for a named room. Holds no resources of its own;
 *  callers attach a {@link RoomSession} via {@link RoomBridge.attach}. */
export function createRoomBridge(name: string): RoomBridge {
  // The session is attached later — before attach, broadcast/sendSignal no-op
  // and polls queue waiters that fire once the session wires onMessage/onSignal.
  let session: RoomSession | undefined;

  const messageQueue: RoomMessage[] = [];
  const messageWaiters: Array<(m: RoomMessage | null) => void> = [];
  // Single merged mailbox of sender-tagged rtc-* frames. The browser long-polls
  // once (GET /room/signal?handle=SELF) and routes each signal by `from`.
  const signalQueue: RoomSignal[] = [];
  const signalWaiters: Array<(s: RoomSignal | null) => void> = [];

  const drainMessage = (m: RoomMessage): void => {
    // input-safety: peer text is UNTRUSTED display data — sanitized at ingress
    // (the web app renders via textContent too — defense in depth), mirroring
    // the LiveBridge.
    const safe: RoomMessage = { ...m, text: sanitizePeerText(m.text) };
    const waiter = messageWaiters.shift();
    if (waiter !== undefined) {
      waiter(safe);
      return;
    }
    messageQueue.push(safe);
    if (messageQueue.length > MAX_QUEUED_MESSAGES) {
      messageQueue.splice(0, messageQueue.length - MAX_QUEUED_MESSAGES);
    }
  };

  const drainSignal = (from: string, frame: RtcFrame): void => {
    const tagged: RoomSignal = { from, rtc: frame };
    const waiter = signalWaiters.shift();
    if (waiter !== undefined) {
      waiter(tagged);
      return;
    }
    signalQueue.push(tagged);
    if (signalQueue.length > MAX_QUEUED_ROOM_SIGNALS) {
      signalQueue.splice(0, signalQueue.length - MAX_QUEUED_ROOM_SIGNALS);
    }
  };

  return {
    name,
    get self(): string | undefined {
      return session?.hello.handle;
    },
    get members(): readonly LivePeerInfo[] {
      if (session === undefined) return [];
      // Built field-by-field from the hello — the browser gets exactly the
      // display shape, never identity proof material (same as LiveBridge.peers).
      return [...session.members.values()].map((h) => ({
        handle: h.handle,
        league: h.league,
        harness: h.harness,
        ...(h.verified !== undefined ? { verified: h.verified } : {}),
        ...(h.identityVerified !== undefined ? { identityVerified: h.identityVerified } : {}),
      }));
    },
    attach(s) {
      session = s;
      s.onMessage(drainMessage);
      s.onSignal((from, frame) => drainSignal(from, frame));
    },
    broadcast(text) {
      session?.broadcast(text);
    },
    async pollMessage(timeoutMs) {
      if (messageQueue.length > 0) return messageQueue.shift() ?? null;
      return new Promise<RoomMessage | null>((resolve) => {
        const timer = setTimeout(() => {
          const idx = messageWaiters.indexOf(resolve);
          if (idx >= 0) messageWaiters.splice(idx, 1);
          resolve(null);
        }, timeoutMs);
        messageWaiters.push((m) => {
          clearTimeout(timer);
          resolve(m);
        });
      });
    },
    sendSignal(handle, frame) {
      session?.sendSignal(handle, frame);
    },
    async pollSignal(_handle, timeoutMs) {
      // `_handle` is SELF (the local browser's identity). The mailbox is already
      // scoped to this process's RoomSession — every onSignal callback fires
      // for frames addressed *to us*, tagged with the remote sender.
      if (signalQueue.length > 0) return signalQueue.shift() ?? null;
      return new Promise<RoomSignal | null>((resolve) => {
        const timer = setTimeout(() => {
          const idx = signalWaiters.indexOf(resolve);
          if (idx >= 0) signalWaiters.splice(idx, 1);
          resolve(null);
        }, timeoutMs);
        signalWaiters.push((s) => {
          clearTimeout(timer);
          resolve(s);
        });
      });
    },
  };
}

/** Shape served to the page. `totalTokens` is local-only by contract. */
export interface ServerState {
  readonly connected: boolean;
  readonly handle?: string;
  readonly harness?: string;
  readonly league?: string;
  readonly leagueMin?: number;
  readonly totalTokens?: number;
  readonly verified?: boolean;
  readonly candidates: readonly Candidate[];
}

export interface StartServerOptions {
  /** Port to bind; 0 (default) lets the OS pick a free one. */
  readonly port?: number;
  /** Hostname; defaults to 127.0.0.1 (loopback only). */
  readonly hostname?: string;
  /** Default handle if the connect call omits one. */
  readonly handle?: string;
  /** Override the state directory (tests). Defaults to ~/.vibedating. */
  readonly dir?: string;
  /** Override the notification sink (tests). Defaults to vibe-core's `notify`. */
  readonly notify?: NotifySink;
  /** Optional live-signaling bridge. When set, the server exposes
   *  `/api/live/peers`, `/live/signal` (WebRTC signaling) and `/live/message`
   *  (text chat) so the web app can do browser WebRTC + text chat with the
   *  bridge's connected peers. Omit (tests) to keep the server a pure
   *  local-data server with no live routes active. */
  readonly live?: LiveBridge;
  /** Optional room bridge. When set, the server exposes `/api/room`,
   *  `/room/message` (group chat broadcast + merged long-poll) and `/room/signal`
   *  (per-handle WebRTC signaling for full-mesh video) so the web app can render
   *  the room view. Mutually exclusive with {@link live} in practice (cmdOpen
   *  attaches one or the other). */
  readonly room?: RoomBridge;
}

export interface StartedServer {
  readonly server: Server;
  readonly port: number;
  readonly url: string;
}

/** Build the current state snapshot from the persisted profile. */
function currentState(dir?: string): ServerState {
  const p = loadProfile(dir);
  if (!p) return { connected: false, candidates: [] };
  return profileToState(p);
}

function profileToState(p: ProfileState): ServerState {
  return {
    connected: true,
    handle: p.handle,
    harness: p.harness,
    league: p.league,
    leagueMin: p.leagueMin,
    totalTokens: p.totalTokens,
    verified: p.verified,
    candidates: matches(p.league, CANDIDATES),
  };
}

function send(res: ServerResponse, status: number, contentType: string, body: string): void {
  res.statusCode = status;
  res.setHeader('content-type', contentType);
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(data));
}

function readBody(req: IncomingMessage, maxLength?: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let len = 0;
    req.on('data', (c: Buffer) => {
      chunks.push(c);
      len += c.length;
      if (maxLength !== undefined && len > maxLength) {
        req.destroy();
        reject(new Error('payload too large'));
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Start the local server. Resolves once listening; the returned `server` keeps
 * the process alive until `server.close()` is called.
 */
export function startServer(opts: StartServerOptions = {}): Promise<StartedServer> {
  const hostname = opts.hostname ?? '127.0.0.1';
  const server = http.createServer((req, res) => handle(req, res, opts).catch((err) => {
    sendJson(res, 500, { error: err instanceof Error ? err.message : 'internal error' });
  }));

  return new Promise<StartedServer>((resolve, reject) => {
    server.on('error', reject);
    server.listen(opts.port ?? 0, hostname, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : (opts.port ?? 0);
      resolve({ server, port, url: `http://${hostname}:${port}` });
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  opts: StartServerOptions,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/') {
    const turnUrl = process.env['VIBEDATE_TURN_URL'];
    let html = webAppHtml;
    if (turnUrl) {
      const turnUser = process.env['VIBEDATE_TURN_USER'];
      const turnCred = process.env['VIBEDATE_TURN_CRED'];
      const server: any = { urls: turnUrl };
      if (turnUser) server.username = turnUser;
      if (turnCred) server.credential = turnCred;
      const script = `<script>window.__VIBE_ICE__={iceServers:${JSON.stringify([server]).replace(/</g, '\\u003c')}};</script>`;
      html = html.replace('<script>', script + '\n<script>');
    }
    send(res, 200, 'text/html; charset=utf-8', html);
    return;
  }

  if (req.method === 'GET' && pathname === '/api/state') {
    sendJson(res, 200, currentState(opts.dir));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/connect') {
    const body = await readBody(req);
    let parsed: Record<string, unknown> = {};
    if (body.trim() !== '') {
      try {
        parsed = JSON.parse(body) as Record<string, unknown>;
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' });
        return;
      }
    }
    const harness = typeof parsed['harness'] === 'string' ? parsed['harness'] : 'claude-code';
    const handle =
      typeof parsed['handle'] === 'string' && parsed['handle'].trim() !== ''
        ? parsed['handle']
        : (opts.handle ?? '@you');
    const snapshot = await readUsage(harness);
    const profile = connectProfile(snapshot, handle, opts.dir);
    sendJson(res, 200, profileToState(profile));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/match') {
    const body = await readBody(req);
    let parsed: Record<string, unknown> = {};
    if (body.trim() !== '') {
      try {
        parsed = JSON.parse(body) as Record<string, unknown>;
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' });
        return;
      }
    }
    const candidateHandle = typeof parsed['handle'] === 'string' ? parsed['handle'] : '';
    if (candidateHandle === '') {
      sendJson(res, 400, { error: 'missing candidate handle' });
      return;
    }
    const profile = loadProfile(opts.dir);
    if (!profile) {
      sendJson(res, 409, { error: 'not connected' });
      return;
    }
    const candidate = CANDIDATES.find((c) => c.handle === candidateHandle);
    if (!candidate) {
      sendJson(res, 404, { error: 'unknown candidate' });
      return;
    }
    // A match is confirmed only within the SAME league — stricter than the
    // pure matches() filter, which also surfaces adjacent leagues.
    const matched = candidate.league === profile.league;
    if (matched) {
      const sink: NotifySink = opts.notify ?? vibeCoreNotify;
      try {
        sink(
          makeEvent('match', profile.harness, process.cwd(), {
            summary: `matched with ${candidate.handle} - SAME LEAGUE`,
            handle: candidate.handle,
            league: profile.league,
          }),
        );
      } catch {
        /* best effort — a notification failure must never break matching */
      }
    }
    sendJson(res, 200, { matched, handle: candidate.handle, league: candidate.league });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/live/peers') {
    const live = opts.live;
    sendJson(res, 200, { peers: live ? live.peers : [] });
    return;
  }

  // GET /live/signal?handle=<peerHandle>  — long-poll for the next incoming
  // rtc-* frame from that peer. Returns {frame} where frame is the parsed
  // RtcFrame or null on timeout. The browser loops on this to receive the
  // remote's answer + trickle ICE candidates.
  if (req.method === 'GET' && pathname === '/live/signal') {
    const live = opts.live;
    if (!live) {
      sendJson(res, 200, { frame: null, reason: 'live-not-attached' });
      return;
    }
    const handle = url.searchParams.get('handle') ?? '';
    if (handle === '') {
      sendJson(res, 400, { error: 'missing handle' });
      return;
    }
    const frame = await live.pollSignal(handle, 25_000);
    // The client may have hung up while we were long-polling — don't write to a
    // dead socket.
    if (req.destroyed || res.writableEnded) return;
    sendJson(res, 200, { frame });
    return;
  }

  // POST /live/signal  {handle, frame}  — relay one rtc-* frame from the
  // browser to the peer's PeerLink. The frame is re-parsed through parseFrame's
  // allowlist so a browser can NEVER smuggle extra keys / oversized payloads
  // onto the P2P wire.
  if (req.method === 'POST' && pathname === '/live/signal') {
    const live = opts.live;
    if (!live) {
      sendJson(res, 400, { error: 'live-not-attached' });
      return;
    }
    const body = await readBody(req);
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(body) as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: 'invalid JSON body' });
      return;
    }
    const handle = typeof parsed['handle'] === 'string' ? parsed['handle'] : '';
    if (handle === '') {
      sendJson(res, 400, { error: 'missing handle' });
      return;
    }
    // Re-serialize + re-parse the claimed frame through parseFrame BEFORE it
    // reaches the PeerLink. The only thing that should be here is a browser
    // RTCSessionDescription / ICE candidate, but we do not trust it.
    const reParsed = parseFrame(JSON.stringify(parsed['frame']));
    if (
      reParsed === null ||
      (reParsed.t !== 'rtc-offer' && reParsed.t !== 'rtc-answer' && reParsed.t !== 'rtc-ice')
    ) {
      sendJson(res, 400, { error: 'invalid rtc frame' });
      return;
    }
    live.sendSignal(handle, reParsed);
    sendJson(res, 200, { ok: true });
    return;
  }

  // GET /live/message?handle=<peerHandle>  — long-poll for the next incoming
  // text message from that peer. Returns {message} (a msg payload: id/text/at)
  // or {message: null} on timeout. The browser runs one poll loop per peer.
  if (req.method === 'GET' && pathname === '/live/message') {
    const live = opts.live;
    if (!live) {
      sendJson(res, 200, { message: null, reason: 'live-not-attached' });
      return;
    }
    const handle = url.searchParams.get('handle') ?? '';
    if (handle === '') {
      sendJson(res, 400, { error: 'missing handle' });
      return;
    }
    const message = await live.pollMessage(handle, 25_000);
    // The client may have hung up while we were long-polling — don't write to a
    // dead socket.
    if (req.destroyed || res.writableEnded) return;
    sendJson(res, 200, { message });
    return;
  }

  // POST /live/message  {handle, text}  — relay one text message from the
  // browser to the peer's PeerLink. The text is round-tripped through
  // parseFrame's allowlist as a real `msg` frame BEFORE it reaches the wire —
  // the same defense-in-depth as POST /live/signal.
  if (req.method === 'POST' && pathname === '/live/message') {
    const live = opts.live;
    if (!live) {
      sendJson(res, 400, { error: 'live-not-attached' });
      return;
    }
    const body = await readBody(req);
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(body) as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: 'invalid JSON body' });
      return;
    }
    const handle = typeof parsed['handle'] === 'string' ? parsed['handle'] : '';
    if (handle === '') {
      sendJson(res, 400, { error: 'missing handle' });
      return;
    }
    const text = parsed['text'];
    if (typeof text !== 'string') {
      sendJson(res, 400, { error: 'missing text' });
      return;
    }
    // Build the exact frame this text would ride on and re-parse it through
    // the allowlist — an empty / oversized / non-string payload never reaches
    // the PeerLink. id + at are minted HERE; the browser supplies text only,
    // and extra keys on the body can't leak into the wire frame by construction.
    const reParsed = parseFrame(
      JSON.stringify({ t: 'msg', id: randomUUID(), text, at: Date.now() }),
    );
    if (reParsed === null || reParsed.t !== 'msg') {
      sendJson(res, 400, { error: 'invalid message text' });
      return;
    }
    live.sendMessage(handle, reParsed.text);
    sendJson(res, 200, { ok: true });
    return;
  }

  // GET /live/media?handle=<peerHandle>  — long-poll for the next incoming
  // media file from that peer. Returns {media} (a media payload: name/mime/dataB64)
  // or {media: null} on timeout. The browser runs one poll loop per peer.
  if (req.method === 'GET' && pathname === '/live/media') {
    const live = opts.live;
    if (!live) {
      sendJson(res, 200, { media: null, reason: 'live-not-attached' });
      return;
    }
    const handle = url.searchParams.get('handle') ?? '';
    if (handle === '') {
      sendJson(res, 400, { error: 'missing handle' });
      return;
    }
    const media = await live.pollMedia(handle, 25_000);
    if (req.destroyed || res.writableEnded) return;
    sendJson(res, 200, { media });
    return;
  }

  // POST /live/media  {handle, name, mime, dataB64}  — relay one media file from the
  // browser to the peer's PeerLink. Write to temp file and then send.
  // 25MiB decoded max.
  if (req.method === 'POST' && pathname === '/live/media') {
    const live = opts.live;
    if (!live) {
      sendJson(res, 400, { error: 'live-not-attached' });
      return;
    }
    let body: string;
    try {
      // Allow up to 35MB base64 JSON payload (which decodes to ~25MB bytes).
      body = await readBody(req, 35 * 1024 * 1024);
    } catch (e: any) {
      sendJson(res, 413, { error: 'payload too large' });
      return;
    }
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(body) as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: 'invalid JSON body' });
      return;
    }
    const handle = typeof parsed['handle'] === 'string' ? parsed['handle'] : '';
    const name = typeof parsed['name'] === 'string' ? parsed['name'] : '';
    const mime = typeof parsed['mime'] === 'string' ? parsed['mime'] : '';
    const dataB64 = typeof parsed['dataB64'] === 'string' ? parsed['dataB64'] : '';
    if (handle === '' || name === '' || mime === '' || dataB64 === '') {
      sendJson(res, 400, { error: 'missing handle, name, mime, or dataB64' });
      return;
    }
    const decoded = Buffer.from(dataB64, 'base64');
    if (decoded.length > 25 * 1024 * 1024) {
      sendJson(res, 413, { error: 'file exceeds 25MiB limit' });
      return;
    }
    const tmpPath = path.join(os.tmpdir(), `vibe-media-send-${randomUUID()}`);
    await fs.promises.writeFile(tmpPath, decoded);
    try {
      await live.sendMedia(handle, tmpPath);
    } catch (err: any) {
      sendJson(res, 500, { error: err.message });
      return;
    } finally {
      await fs.promises.unlink(tmpPath).catch(() => {});
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  // ---- Room routes (active only when a RoomBridge is attached) ----
  // Group chat + full-mesh WebRTC signaling for named rooms. The signaling
  // relay mirrors /live/signal exactly (re-parse every claimed frame through
  // parseFrame's allowlist before it reaches a PeerLink); group chat is a
  // broadcast (fan-out to every member) with a single MERGED long-poll for
  // incoming messages from anyone.

  // GET /api/room  -> { room, self, members } when a room is attached, else
  // { room: null, members: [] }. The web app uses this to decide whether to
  // render the room view.
  if (req.method === 'GET' && pathname === '/api/room') {
    const room = opts.room;
    sendJson(res, 200, room
      ? { room: room.name, self: room.self ?? null, members: room.members }
      : { room: null, self: null, members: [] });
    return;
  }

  // GET /room/message  — long-poll for the next incoming group message from
  // ANY member (merged). Returns {message} (a RoomMessage: from/id/text/at) or
  // {message: null} on timeout. One poll loop drives the whole room chat.
  if (req.method === 'GET' && pathname === '/room/message') {
    const room = opts.room;
    if (!room) {
      sendJson(res, 200, { message: null, reason: 'room-not-attached' });
      return;
    }
    const message = await room.pollMessage(25_000);
    if (req.destroyed || res.writableEnded) return;
    sendJson(res, 200, { message });
    return;
  }

  // POST /room/message  {text}  — broadcast one text to ALL room members. The
  // text is round-tripped through parseFrame's allowlist as a real `msg` frame
  // BEFORE it reaches the wire — the same defense-in-depth as POST /live/message.
  if (req.method === 'POST' && pathname === '/room/message') {
    const room = opts.room;
    if (!room) {
      sendJson(res, 400, { error: 'room-not-attached' });
      return;
    }
    const body = await readBody(req);
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(body) as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: 'invalid JSON body' });
      return;
    }
    const text = parsed['text'];
    if (typeof text !== 'string') {
      sendJson(res, 400, { error: 'missing text' });
      return;
    }
    const reParsed = parseFrame(
      JSON.stringify({ t: 'msg', id: randomUUID(), text, at: Date.now() }),
    );
    if (reParsed === null || reParsed.t !== 'msg') {
      sendJson(res, 400, { error: 'invalid message text' });
      return;
    }
    room.broadcast(reParsed.text);
    sendJson(res, 200, { ok: true });
    return;
  }

  // GET /room/signal?handle=<SELF>  — long-poll the merged full-mesh mailbox
  // for the next incoming rtc-* frame from ANY room member. Returns
  // { frame: { from, rtc } } so the browser can route to the right PC, or
  // { frame: null } on timeout. (`handle` is the local member's identity.)
  if (req.method === 'GET' && pathname === '/room/signal') {
    const room = opts.room;
    if (!room) {
      sendJson(res, 200, { frame: null, reason: 'room-not-attached' });
      return;
    }
    const handle = url.searchParams.get('handle') ?? '';
    if (handle === '') {
      sendJson(res, 400, { error: 'missing handle' });
      return;
    }
    const frame = await room.pollSignal(handle, 25_000);
    if (req.destroyed || res.writableEnded) return;
    sendJson(res, 200, { frame });
    return;
  }

  // POST /room/signal  {handle, frame}  — relay one rtc-* frame from the
  // browser to one member's PeerLink. Re-parsed through parseFrame's allowlist
  // so a browser can NEVER smuggle extra keys / oversized payloads onto the
  // P2P wire (same guard as POST /live/signal).
  if (req.method === 'POST' && pathname === '/room/signal') {
    const room = opts.room;
    if (!room) {
      sendJson(res, 400, { error: 'room-not-attached' });
      return;
    }
    const body = await readBody(req);
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(body) as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: 'invalid JSON body' });
      return;
    }
    const handle = typeof parsed['handle'] === 'string' ? parsed['handle'] : '';
    if (handle === '') {
      sendJson(res, 400, { error: 'missing handle' });
      return;
    }
    const reParsed = parseFrame(JSON.stringify(parsed['frame']));
    if (
      reParsed === null ||
      (reParsed.t !== 'rtc-offer' && reParsed.t !== 'rtc-answer' && reParsed.t !== 'rtc-ice')
    ) {
      sendJson(res, 400, { error: 'invalid rtc frame' });
      return;
    }
    room.sendSignal(handle, reParsed);
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}
