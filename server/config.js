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

/**
 * VAPID keypair for Web Push, generated on first use and written 0600.
 *
 * The private key is what authenticates this server to Apple's and Google's
 * push services as the owner of every subscription it holds, so it is a secret
 * of the same weight as .token and is gitignored alongside it. Only the public
 * half ever reaches a browser.
 */
export const VAPID_PATH = path.join(PROJECT_ROOT, '.vapid.json');

/**
 * Push subscriptions, one per installed phone. 0600 and gitignored: each record
 * carries the endpoint URL plus the p256dh/auth key pair, and anyone holding
 * those can push a notification to that device.
 */
export const PUSH_SUBSCRIPTIONS_PATH = path.join(PROJECT_ROOT, '.push-subscriptions.json');

/**
 * VAPID `sub` claim — a contact for whoever operates this push sender. RFC 8292
 * requires a `mailto:` or `https:` URL, and Apple rejects a token without one.
 * Nobody verifies it, but it must be well-formed.
 *
 * This defaults to the project's own URL, not to the machine's. A tailnet
 * hostname is private infrastructure, and this value travels to Apple's and
 * Google's push endpoints on every notification, so baking one in would leak it
 * off the tailnet. Set `CCR_VAPID_SUBJECT` if you want your own contact there.
 */
export const VAPID_SUBJECT =
  process.env.CCR_VAPID_SUBJECT || 'https://github.com/tdickers22-lgtm/vibermote';

/* ------------------------------------------------------------------ *
 * Notification tuning
 *
 * Every constant here exists to keep the notification count low enough that
 * the user never mutes the app. They are the difference between "my Mac tells
 * me when the agent needs me" and a stream of noise.
 * ------------------------------------------------------------------ */

/** How often session-watch samples tmux. Cheap: one list-sessions + one capture-pane per session. */
export const PUSH_POLL_MS = Number(process.env.CCR_PUSH_POLL_MS || 5000);

/**
 * A session whose visible pane has not changed for this long, having previously
 * been changing, is a candidate for "waiting for input". Long enough that a
 * model thinking between two frames is not mistaken for a finished turn.
 */
export const PUSH_QUIET_MS = Number(process.env.CCR_PUSH_QUIET_MS || 45_000);

/**
 * A foreground process must have run at least this long before its exit is
 * worth a notification. Without it every `ls` in a shell session would push.
 */
export const PUSH_MIN_RUN_MS = Number(process.env.CCR_PUSH_MIN_RUN_MS || 30_000);

/** No session may produce two notifications closer together than this. */
export const PUSH_SESSION_COOLDOWN_MS = Number(process.env.CCR_PUSH_COOLDOWN_MS || 60_000);

/**
 * After a job exits, the shell prompt that replaces it repaints the pane. That
 * is a screen change, and without this window it would re-arm the idle detector
 * and produce a second "waiting for your input" for an event already reported.
 * Changes inside this window still count as activity; they just do not re-arm.
 */
export const PUSH_EXIT_SETTLE_MS = Number(process.env.CCR_PUSH_SETTLE_MS || 10_000);

/** Hard ceiling across all sessions, so a pathological loop cannot spam the phone. */
export const PUSH_RATE_MAX = 6;
export const PUSH_RATE_WINDOW_MS = 5 * 60_000;

/** How long a push service should hold an undelivered notification. */
export const PUSH_TTL_SECONDS = Number(process.env.CCR_PUSH_TTL || 4 * 60 * 60);

/** Consecutive delivery failures before a subscription is dropped as dead. */
export const PUSH_MAX_FAILURES = 8;

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
