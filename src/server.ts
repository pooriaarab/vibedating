/**
 * The local web app server. Node's built-in `http` only — no new deps.
 *
 * Routes (all localhost, all local data):
 *   GET  /             -> the dating UI (see ./web-app-html.ts)
 *   GET  /api/state    -> { connected, ...profile, candidates: matches }
 *   POST /api/connect  -> read usage, compute + store league, return new state
 *
 * Raw token usage appears in /api/state so the local page can show it behind an
 * opt-in toggle. It is never sent anywhere off-machine (there is no off-machine).
 */
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Candidate } from './index.js';
import { CANDIDATES, matches, readUsage } from './index.js';
import { connectProfile, loadProfile, type ProfileState } from './state.js';
import { webAppHtml } from './web-app-html.js';

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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
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
    send(res, 200, 'text/html; charset=utf-8', webAppHtml);
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

  sendJson(res, 404, { error: 'not found' });
}
