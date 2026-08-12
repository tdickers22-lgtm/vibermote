/**
 * Central configuration. Everything tunable lives here so the rest of the
 * server never hardcodes a path or a magic number.
 *
 * Note on binaries: this file no longer resolves per-tool binaries. Each
 * session kind declares its own binary and candidate paths in kinds.js, which
 * is the single place a new tool gets added.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const HOME = os.homedir();

/** Root of this project. config.js lives in <root>/server/. */
export const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

/** Bearer token file. Created on first run with 0600. */
export const TOKEN_PATH = path.join(PROJECT_ROOT, '.token');

/**
 * The user's own saved commands (`npm run dev`, `pytest`, a training tail…).
 *
 * 0600 like the token: these are command lines that this server will execute,
 * so a world-writable file here would be a way to get code run without the
 * token. Anyone who can write it can already write .token, but the permission
 * is asserted anyway rather than assumed.
 */
export const SAVED_COMMANDS_PATH = path.join(PROJECT_ROOT, '.commands.json');

/** Read-only source of resumable Claude Code sessions. NEVER written to. */
export const CLAUDE_PROJECTS_DIR = path.join(HOME, '.claude', 'projects');

/** Read-only source of resumable Codex sessions (rollout JSONL). NEVER written to. */
export const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, '.codex');
export const CODEX_SESSIONS_DIR = path.join(CODEX_HOME, 'sessions');

/** Every tmux session we manage carries this prefix so we never touch the user's own. */
export const TMUX_PREFIX = 'ccr-';

/**
 * PATH handed to every process we spawn.
 *
 * Under launchd the inherited PATH is /usr/bin:/bin:/usr/sbin:/sbin, which
 * contains none of the CLIs this server launches. A session started that way
 * dies instantly with a blank terminal and no visible cause, so the directories
 * that actually hold the tools are prepended unconditionally.
 */
export const EXTRA_PATH_DIRS = [
  path.join(HOME, '.local', 'bin'),
  path.join(HOME, '.nvm', 'versions', 'node', 'v20.20.0', 'bin'),
  path.join(HOME, '.opencode', 'bin'),
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
];

/** De-duplicated PATH: our directories first, then whatever we inherited. */
export const HARDENED_PATH = buildHardenedPath();

function buildHardenedPath() {
  const inherited = (process.env.PATH || '').split(':').filter(Boolean);
  const base = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const seen = new Set();
  const out = [];
  for (const dir of [...EXTRA_PATH_DIRS, ...inherited, ...base]) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    out.push(dir);
  }
  return out.join(':');
}

/**
 * Locale forced on tmux and on everything spawned inside it.
 *
 * launchd starts a job with no LANG at all, and a tmux that cannot see a UTF-8
 * locale drops out of UTF-8 mode. Two things break at once: the box-drawing
 * characters both Claude Code and Codex build their TUI from render as
 * garbage, and tmux starts rewriting non-printable bytes in `-F` format output
 * (which is how session listing used to corrupt every field). Forcing a UTF-8
 * locale fixes both, so it is as load-bearing as PATH here.
 */
export const LOCALE = /utf-?8/i.test(process.env.LC_ALL || process.env.LANG || '')
  ? process.env.LC_ALL || process.env.LANG
  : 'en_US.UTF-8';

/** Absolute tmux path (Homebrew on Apple Silicon), overridable. */
export const TMUX_BIN = process.env.CCR_TMUX || firstExisting([
  '/opt/homebrew/bin/tmux',
  '/usr/local/bin/tmux',
  '/usr/bin/tmux',
]) || 'tmux';

/** Login shell used for the `shell` kind and as the fallback after a tool exits. */
export const LOGIN_SHELL = process.env.CCR_SHELL || process.env.SHELL || '/bin/zsh';

export const PORT = Number(process.env.CCR_PORT || 8787);

/** Explicit bind override. Validated in net.js — 0.0.0.0 is rejected outright. */
export const HOST_OVERRIDE = process.env.CCR_HOST || null;

/** Lines of tmux scrollback replayed on attach so the phone shows context instantly. */
export const REPLAY_LINES = Number(process.env.CCR_REPLAY_LINES || 400);

/** PTY output is coalesced over this window to cut frame count on cellular links. */
export const OUTPUT_FLUSH_MS = 8;

/** Bytes of recent output retained per session for instant re-attach. */
export const RING_BYTES = 256 * 1024;

/**
 * How long a PTY (a tmux *client*) is kept alive after the last websocket leaves.
 * The tmux *session* always survives; this only trades memory for reattach latency.
 */
export const IDLE_DETACH_MS = Number(process.env.CCR_IDLE_DETACH_MS || 5 * 60 * 1000);

/** Websocket liveness probing — phones sleep and leave half-open sockets behind. */
export const WS_PING_MS = 30_000;

/** Drop output to a client whose buffer exceeds this; it is too slow to keep up. */
export const WS_BACKPRESSURE_BYTES = 4 * 1024 * 1024;

/** Default PTY geometry before the client reports its real size. */
export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;

/** Failed-auth throttling per source IP. */
export const AUTH_MAX_FAILURES = 10;
export const AUTH_LOCKOUT_MS = 60_000;

/** First path in `candidates` that exists and is executable, else null. */
export function firstExisting(candidates) {
  for (const c of candidates) {
    if (!c) continue;
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/** Look up `name` on HARDENED_PATH, the way execvp would. */
export function findOnHardenedPath(name) {
  if (name.includes('/')) return firstExisting([name]);
  return firstExisting(HARDENED_PATH.split(':').map((dir) => path.join(dir, name)));
}
