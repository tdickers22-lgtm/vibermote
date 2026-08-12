/**
 * Facts about the Mac that the phone cannot work out for itself, plus the one
 * piece of per-device state that belongs beside them: the directory the user
 * last worked in.
 *
 * Everything here degrades rather than fails. A server too old to answer
 * `/api/env` leaves the tmux prefix at C-b (tmux's documented default) and the
 * home directory empty — and an empty cwd is not a broken request, because
 * `POST /api/sessions` falls back to the server's own $HOME.
 */

import { api } from './api.js';

const LAST_CWD_KEY = 'claude-remote:lastCwd';

/** tmux's default prefix, C-b. Used until the server tells us otherwise. */
const DEFAULT_PREFIX = { key: 'C-b', seq: '\x02', source: 'assumed' };

let env = { home: '', shell: '', tmux: { prefix: DEFAULT_PREFIX } };

/** Best-effort: never let a missing endpoint keep the app off the screen. */
export async function loadEnv() {
  try {
    const payload = await api.env();
    if (!payload || typeof payload !== 'object') return env;
    const prefix = payload.tmux?.prefix;
    env = {
      home: typeof payload.home === 'string' ? payload.home : '',
      shell: typeof payload.shell === 'string' ? payload.shell : '',
      tmux: {
        ...payload.tmux,
        prefix: typeof prefix?.seq === 'string' && prefix.seq ? prefix : DEFAULT_PREFIX,
      },
    };
  } catch {
    /* keep the defaults */
  }
  return env;
}

export function homeDir() { return env.home || ''; }

/** The bytes the user's prefix key produces — `\x02` for C-b, `\x01` for C-a. */
export function tmuxPrefix() { return env.tmux?.prefix?.seq || DEFAULT_PREFIX.seq; }

/** Human name of the prefix, for labelling the pane controls. */
export function tmuxPrefixName() { return env.tmux?.prefix?.key || DEFAULT_PREFIX.key; }

export function lastCwd() {
  try {
    return localStorage.getItem(LAST_CWD_KEY) || '';
  } catch {
    return '';
  }
}

/** Remember where the user just worked, so the next shell starts there. */
export function rememberCwd(cwd) {
  if (typeof cwd !== 'string' || !cwd.trim()) return;
  try { localStorage.setItem(LAST_CWD_KEY, cwd.trim()); } catch { /* ignore */ }
}

/**
 * Where a one-tap terminal should start: the directory the user last worked
 * in, else this Mac's home directory, else whatever the caller can offer.
 */
export function defaultCwd(fallback = '') {
  return lastCwd() || homeDir() || fallback || '';
}
