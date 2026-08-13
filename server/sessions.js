/**
 * Session brokers: one PTY per tmux session, many websocket subscribers.
 *
 * Why one shared PTY rather than one PTY per phone: two tmux clients attached
 * to the same session negotiate a shared size, and the smaller client would
 * silently letterbox the larger. Sharing a single PTY makes the fan-out
 * explicit and keeps every viewer byte-identical.
 *
 * The tmux *session* outlives the PTY. Dropping the PTY is exactly a detach,
 * which is why a dead socket, a crashed client, or an idle timeout can never
 * destroy the user's work.
 */
import { EventEmitter } from 'node:events';
import pty from 'node-pty';
import {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  HARDENED_PATH,
  IDLE_DETACH_MS,
  LOGIN_SHELL,
  OUTPUT_FLUSH_MS,
  REPLAY_LINES,
  RING_BYTES,
  TMUX_BIN,
} from './config.js';
import { DEFAULT_KIND, getKind, resolveKindBinary, tmuxNameFor } from './kinds.js';
import { forgetSession } from './session-watch.js';
import * as tmuxApi from './tmux.js';
import { log, shQuote } from './util.js';

/**
 * Environment for everything we spawn.
 *
 * PATH is replaced, not extended, because the inherited one is the problem:
 * under launchd this process starts with /usr/bin:/bin:/usr/sbin:/sbin and
 * none of the CLIs are on it. TMUX is stripped so a server that was itself
 * started from inside tmux cannot nest sessions.
 */
export function buildSpawnEnv(extra = {}) {
  const env = {
    ...process.env,
    PATH: HARDENED_PATH,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    ...extra,
  };
  delete env.TMUX;
  delete env.TMUX_PANE;
  return env;
}

/** tmux session name -> SessionBroker */
const brokers = new Map();

export class SessionBroker extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
    this.subscribers = new Set();
    this.pty = null;
    this.cols = DEFAULT_COLS;
    this.rows = DEFAULT_ROWS;
    this.ring = [];
    this.ringBytes = 0;
    this.pending = [];
    this.pendingBytes = 0;
    this.flushTimer = null;
    this.idleTimer = null;
    this.starting = null;
    this.closed = false;
  }

  /* ---------------------------------------------------------------- *
   * PTY lifecycle
   * ---------------------------------------------------------------- */

  /**
   * Spawn the tmux client PTY if it is not already running.
   * `new-session -A` attaches when the session exists and creates it
   * otherwise, so reconnecting never duplicates a session.
   */
  async ensurePty() {
    if (this.pty) return this.pty;
    if (this.starting) return this.starting;

    this.starting = (async () => {
      const env = buildSpawnEnv();

      const child = pty.spawn(
        TMUX_BIN,
        ['new-session', '-A', '-s', this.name],
        {
          name: 'xterm-256color',
          cols: this.cols,
          rows: this.rows,
          cwd: process.env.HOME,
          env,
          encoding: null, // deliver raw Buffers; xterm.js decodes UTF-8 itself
        },
      );

      child.onData((chunk) => this.#onPtyData(chunk));
      child.onExit(({ exitCode, signal }) => this.#onPtyExit(exitCode, signal));

      this.pty = child;
      log.info(`pty attached to tmux session ${this.name} (pid ${child.pid})`);
      return child;
    })();

    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  #onPtyData(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');

    // Ring buffer of recent output, so a reattaching client has context even
    // if capture-pane is unavailable.
    this.ring.push(buf);
    this.ringBytes += buf.length;
    while (this.ringBytes > RING_BYTES && this.ring.length > 1) {
      this.ringBytes -= this.ring.shift().length;
    }

    // Coalesce: a TUI emits many tiny writes, and one websocket frame per write
    // is brutal on a cellular link.
    this.pending.push(buf);
    this.pendingBytes += buf.length;

    if (this.pendingBytes >= 64 * 1024) {
      this.#flush();
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.#flush(), OUTPUT_FLUSH_MS);
    }
  }

  #flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.pending.length) return;
    const payload = this.pending.length === 1 ? this.pending[0] : Buffer.concat(this.pending, this.pendingBytes);
    this.pending = [];
    this.pendingBytes = 0;
    this.emit('data', payload);
  }

  #onPtyExit(exitCode, signal) {
    log.info(`pty for ${this.name} exited (code=${exitCode} signal=${signal ?? 'none'})`);
    this.#flush();
    this.pty = null;

    // Distinguish "tmux session is gone" from "we merely detached".
    tmuxApi
      .hasSession(this.name)
      .then((alive) => {
        this.emit('pty-exit', { exitCode, signal, sessionAlive: alive });
        if (!alive) this.dispose('session-ended');
      })
      .catch(() => {
        this.emit('pty-exit', { exitCode, signal, sessionAlive: false });
        this.dispose('session-ended');
      });
  }

  /* ---------------------------------------------------------------- *
   * Subscribers
   * ---------------------------------------------------------------- */

  addSubscriber(sub) {
    this.subscribers.add(sub);
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  removeSubscriber(sub) {
    this.subscribers.delete(sub);
    if (this.subscribers.size === 0) this.#scheduleIdleDetach();
  }

  /**
   * With nobody watching, keep the PTY for a grace period so a phone that
   * flaps between cellular and wifi reattaches instantly, then let it go.
   * The tmux session is unaffected either way.
   */
  #scheduleIdleDetach() {
    if (this.idleTimer || !this.pty) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.subscribers.size === 0 && this.pty) {
        log.info(`idle detach from ${this.name} (session keeps running)`);
        this.detach();
      }
    }, IDLE_DETACH_MS);
    if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref();
  }

  /* ---------------------------------------------------------------- *
   * I/O
   * ---------------------------------------------------------------- */

  /**
   * Write client input to the PTY.
   *
   * Buffers are passed through untouched: node-pty's write stream takes them
   * directly, and converting to a latin1 string first would mangle every
   * multi-byte character the user types.
   */
  write(data) {
    if (!this.pty) return false;
    this.pty.write(data);
    return true;
  }

  /**
   * Size arbitration across subscribers.
   *
   * The smallest reported viewport wins. A PTY sized larger than a viewer's
   * screen does not merely look wrong — the TUI's absolute cursor addressing
   * lands in the wrong cells and the render corrupts. Clamping to the minimum
   * guarantees every attached phone can render the full frame.
   */
  applyResize() {
    let cols = Infinity;
    let rows = Infinity;
    for (const sub of this.subscribers) {
      if (sub.cols > 0 && sub.rows > 0) {
        cols = Math.min(cols, sub.cols);
        rows = Math.min(rows, sub.rows);
      }
    }
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return false;

    cols = Math.max(20, Math.min(500, Math.floor(cols)));
    rows = Math.max(5, Math.min(200, Math.floor(rows)));

    if (cols === this.cols && rows === this.rows) return false;
    this.cols = cols;
    this.rows = rows;

    if (this.pty) {
      try {
        this.pty.resize(cols, rows);
      } catch (err) {
        log.warn(`resize failed for ${this.name}: ${err.message}`);
        return false;
      }
    }
    return true;
  }

  /** Recent scrollback for immediate context on attach. */
  async replayBuffer() {
    const captured = await tmuxApi.capturePane(this.name, REPLAY_LINES);
    if (captured) {
      // Home the cursor and clear so the replay starts from a known state.
      return Buffer.from(`\x1b[H\x1b[2J${captured.replace(/\n/g, '\r\n')}\r\n`, 'utf8');
    }
    if (this.ringBytes) return Buffer.concat(this.ring, this.ringBytes);
    return Buffer.alloc(0);
  }

  /** Drop the PTY but leave the tmux session running. This is "detach". */
  detach() {
    this.#flush();
    if (this.pty) {
      try {
        // Kill the tmux *client* process; the server and session survive.
        this.pty.kill();
      } catch (err) {
        log.debug(`detach kill failed for ${this.name}: ${err.message}`);
      }
      this.pty = null;
    }
  }

  dispose(reason) {
    if (this.closed) return;
    this.closed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.detach();
    this.emit('disposed', reason);
    brokers.delete(this.name);
    log.debug(`broker disposed for ${this.name} (${reason})`);
  }
}

/* ------------------------------------------------------------------ *
 * Registry
 * ------------------------------------------------------------------ */

export function getBroker(name, { create = true } = {}) {
  if (!tmuxApi.isManaged(name)) throw new Error(`refusing to broker unmanaged session "${name}"`);
  let broker = brokers.get(name);
  if (!broker && create) {
    broker = new SessionBroker(name);
    brokers.set(name, broker);
  }
  return broker || null;
}

export function peekBroker(name) {
  return brokers.get(name) || null;
}

export function allBrokers() {
  return [...brokers.values()];
}

/**
 * Build the command tmux runs for a new session.
 *
 * For a tool kind the binary runs first; when it exits we print its status and
 * drop into an interactive login shell rather than letting the tmux session
 * evaporate. On a phone that difference matters: a session that vanishes on
 * crash takes the error message with it, and there is no scrollback left to
 * diagnose from.
 *
 * PATH is exported inside the script as well as being set on the tmux session,
 * because a login shell on macOS runs path_helper and rebuilds PATH from
 * /etc/paths — belt and braces, since the binary itself is invoked absolute.
 *
 * A plain shell is exec'd directly: when the user exits their shell the
 * terminal window should close, not reincarnate.
 */
export function buildKindCommand({ kindId, binPath, argv = [] }) {
  const kind = getKind(kindId);
  if (!kind) throw new Error(`unknown session kind "${kindId}"`);

  if (kindId === 'shell') return [binPath, ...argv];

  const inner = [shQuote(binPath), ...argv.map(shQuote)].join(' ');
  const script =
    `export PATH=${shQuote(HARDENED_PATH)}; ` +
    `${inner}; status=$?; ` +
    `printf '\\n\\033[2m[%s exited with status %s — shell follows]\\033[0m\\n' ` +
    `${shQuote(kind.displayName)} "$status"; ` +
    `exec ${shQuote(LOGIN_SHELL)} -l`;
  return ['/bin/sh', '-c', script];
}

/**
 * Create a brand-new managed tmux session of a given kind.
 *
 * @param {object} opts
 * @param {string} [opts.kind]       registry kind id; defaults to claude
 * @param {string} opts.projectDir   directory to start in
 * @param {string} [opts.resumeId]   prior session id of that kind to resume
 * @param {string[]} [opts.args]     extra CLI args
 * @param {string} [opts.label]      label used to build the tmux name
 * @param {string} [opts.command]    command line, for kinds that take one (`custom`)
 * @returns {Promise<{name:string, kind:string, binPath:string, argv:string[]}>}
 */
export async function createSession({
  kind = DEFAULT_KIND,
  projectDir,
  resumeId = null,
  args = [],
  label = null,
  command = null,
}) {
  const k = getKind(kind);
  if (!k) throw new Error(`unknown session kind "${kind}"`);

  if (k.requiresCommand && !(typeof command === 'string' && command.trim())) {
    throw new Error(`a "${kind}" session needs a command to run`);
  }

  // Resolve before touching tmux so a missing tool fails with a specific,
  // actionable message instead of a session that dies with a blank screen.
  const binPath = resolveKindBinary(kind);

  let argv;
  if (resumeId) {
    if (typeof k.resumeArgv !== 'function') {
      throw new Error(`${k.displayName} sessions cannot be resumed`);
    }
    if (!k.isResumeId(resumeId)) {
      throw new Error(`"${resumeId}" is not a valid ${k.displayName} session id`);
    }
    argv = k.resumeArgv({ sessionId: resumeId, args });
  } else {
    argv = k.launchArgv({ args, command });
  }

  const base = tmuxNameFor(kind, label || basenameOf(projectDir));
  const name = await tmuxApi.uniqueSessionName(base);

  // The command line is logged; the token never is (util.js redacts it), and a
  // user debugging "why did my session die" needs to see exactly what ran.
  if (command) log.info(`custom command for ${name}: ${command}`);

  await tmuxApi.newSession({
    name,
    cwd: projectDir,
    command: buildKindCommand({ kindId: kind, binPath, argv }),
    // tmux -e seeds the session environment, so anything the user later runs
    // inside the session sees the hardened PATH too.
    env: { PATH: HARDENED_PATH, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  });

  log.info(`created ${kind} session ${name} in ${projectDir}${resumeId ? ` (resuming ${resumeId})` : ''}`);
  return { name, kind, binPath, argv };
}

function basenameOf(p) {
  if (!p) return 'session';
  const trimmed = String(p).replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx >= 0 ? trimmed.slice(idx + 1) || 'root' : trimmed;
}

/** Kill a session for good, tearing down its broker first. */
export async function killSession(name) {
  // Before the session disappears: a kill the user asked for must not come back
  // as an "ended" push notification on the phone they asked from.
  forgetSession(name);
  const broker = peekBroker(name);
  if (broker) broker.dispose('killed');
  await tmuxApi.killSession(name);
  log.info(`killed session ${name}`);
}

/** Detach every PTY without touching the tmux sessions. Used on shutdown. */
export function detachAll() {
  for (const broker of allBrokers()) broker.detach();
}
