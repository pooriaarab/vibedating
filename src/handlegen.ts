/**
 * Zero-friction handle assignment — first `connect` mints a memetic dev-flavored
 * username so nobody ever ships as the bare default `@you`.
 *
 * Generator MECHANISM lives in `@pooriaarab/vibe-core/handle` (word lists +
 * CSPRNG pick — byte-identical to the prior local module). Persistence + the
 * first-run resolve policy ({@link ensureHandle}) stay LOCAL: they own
 * vibedating's state dir, env override, and `@you` default.
 */
import { generateHandle } from '@pooriaarab/vibe-core/handle';
import {
  DEFAULT_HANDLE,
  defaultStateDir,
  loadHandle,
  normalizeHandle,
  saveHandle,
} from './state.js';

export { generateHandle };

/** Outcome of {@link ensureHandle}: the effective handle + whether it was just minted. */
export interface EnsuredHandle {
  readonly handle: string;
  /** True when a new handle was generated and persisted by this call. */
  readonly generated: boolean;
}

/**
 * Resolve the handle for a first-run flow, auto-assigning when unset:
 *   1. a valid `VIBEDATING_HANDLE` env wins as a ONE-OFF (never persisted);
 *   2. a persisted (non-default) handle is reused;
 *   3. otherwise a memetic handle is generated and PERSISTED — the bare
 *      default `@you` is never silently kept.
 */
export function ensureHandle(dir: string = defaultStateDir()): EnsuredHandle {
  const env = process.env['VIBEDATING_HANDLE'];
  if (env !== undefined && env.trim() !== '') {
    const canonical = normalizeHandle(env);
    if (canonical !== null) return { handle: canonical, generated: false };
  }
  const persisted = loadHandle(dir);
  if (persisted !== DEFAULT_HANDLE) return { handle: persisted, generated: false };
  const generated = generateHandle();
  return { handle: saveHandle(generated, dir), generated: true };
}
