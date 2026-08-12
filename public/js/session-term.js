/**
 * One live terminal per session: xterm instance + WebSocket + reconnect policy.
 *
 * Instances are cached (see `getSessionTerm`) so switching sessions like tabs
 * keeps scrollback intact and feels instant.
 */

import { Terminal } from '../vendor/xterm.mjs';
import { FitAddon } from '../vendor/addon-fit.mjs';
import { WebLinksAddon } from '../vendor/addon-web-links.mjs';
import { wsUrl, wsProtocols, api, ApiError } from './api.js';

const FONT_KEY = 'claude-remote:fontSize';

/**
 * Terminals kept alive at once, sockets and scrollback included.
 *
 * This is the ceiling on how many sessions the user can hold open and switch
 * between, so the switcher strip caps itself here too — a tab whose terminal
 * had been evicted would open on a blank screen with no history. Every cached
 * instance costs an xterm buffer and a websocket, so it is not free.
 */
export const MAX_CACHED = 6;

const RECONNECT_BASE = 500;
const RECONNECT_MAX = 15000;
const RECONNECT_FACTOR = 1.7;
const PENDING_TTL = 15000; // drop queued keystrokes older than this
const PENDING_MAX = 2048;

/**
 * Close codes, matched to the server's CLOSE table in server/ws-api.js.
 * Getting these wrong is not cosmetic: an auth rejection classified as a
 * transient drop turns into an infinite reconnect loop against a server that
 * is rate-limiting failed auth attempts, which locks the phone out.
 */
const AUTH_CLOSE_CODES = new Set([
  1008, // policy violation (generic)
  4001, // server CLOSE.UNAUTHORIZED
  4401, 4403, // conventional bearer-ish codes, kept for a future server
]);

/** The session no longer exists — retrying can never succeed. */
const GONE_CLOSE_CODES = new Set([
  4003, // server CLOSE.NOT_FOUND
  4004, // server CLOSE.SESSION_ENDED
  4404, // conventional
]);

/** Server dropped the PTY but the tmux session survives. Stop, don't retry. */
const DETACHED_CLOSE_CODE = 4002;

/** Malformed request — reconnecting with the same parameters would loop. */
const BAD_REQUEST_CLOSE_CODE = 4006;

/** Browser codes meaning "handshake never completed"; hides HTTP 401 upgrades. */
const OPAQUE_CLOSE_CODES = new Set([1005, 1006]);

const THEME = {
  background: '#141413',
  foreground: '#e8e6dc',
  cursor: '#d97757',
  cursorAccent: '#141413',
  selectionBackground: '#3f3b34',
  selectionForeground: '#f5f4ef',
  black: '#2a2825',
  red: '#e07a5f',
  green: '#7fb069',
  yellow: '#e8c547',
  blue: '#6b9bd1',
  magenta: '#c48bb8',
  cyan: '#5fb3b3',
  white: '#d4d1c7',
  brightBlack: '#5c5850',
  brightRed: '#f08a6f',
  brightGreen: '#8fc079',
  brightYellow: '#f5d557',
  brightBlue: '#7babd9',
  brightMagenta: '#d49bc8',
  brightCyan: '#6fc3c3',
  brightWhite: '#f5f4ef',
};

export function getFontSize() {
  const stored = Number(localStorage.getItem(FONT_KEY));
  if (Number.isFinite(stored) && stored >= 8 && stored <= 22) return stored;
  return 11;
}

export function setFontSizePref(px) {
  try { localStorage.setItem(FONT_KEY, String(px)); } catch { /* ignore */ }
}

export class SessionTerm {
  constructor(id) {
    this.id = id;
    this.state = 'idle';
    this.ws = null;
    this.wantOpen = false;
    this.everConnected = false;
    this.attempt = 0;
    this.retryTimer = 0;
    this.stableTimer = 0;
    this.nudgeTimer = 0;
    this.pending = [];
    this.lastSize = { cols: 0, rows: 0 };
    this.opened = false;
    this.transform = null;   // set by the keybar for sticky modifiers
    this.listeners = new Map();
    this.lastActivity = 0;
    this.serverGeometry = null; // authoritative shared PTY size, from the server
    this.latency = null;

    this.term = new Terminal({
      allowProposedApi: false,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorInactiveStyle: 'outline',
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, monospace',
      fontSize: getFontSize(),
      lineHeight: 1.15,
      letterSpacing: 0,
      scrollback: 5000,
      scrollOnUserInput: true,
      convertEol: false,
      theme: THEME,
      // The soft keyboard needs a real focus target; xterm's helper textarea is it.
      screenReaderMode: false,
      macOptionIsMeta: false,
      rightClickSelectsWord: false,
      windowsMode: false,
    });

    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);
    try { this.term.loadAddon(new WebLinksAddon()); } catch { /* optional */ }

    this.term.onData((data) => this.handleTyped(data));
    // onBinary already hands us one char per byte; forward it untouched.
    this.term.onBinary((data) => this.sendRaw(data));
    this.term.onResize(({ cols, rows }) => {
      this.lastSize = { cols, rows };
      this.sendResize(cols, rows);
    });
  }

  /* ------------------------------------------------------------- events */

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.listeners.get(event)?.delete(fn);
  }

  emit(event, payload) {
    for (const fn of this.listeners.get(event) || []) {
      try { fn(payload); } catch (err) { console.error('[session-term]', err); }
    }
  }

  setState(next, detail) {
    if (this.state === next && !detail) return;
    this.state = next;
    this.emit('state', { state: next, detail });
  }

  /* ---------------------------------------------------------- mounting */

  attach(host) {
    if (!this.opened) {
      this.term.open(host);
      this.opened = true;
      this.hardenTextarea();
      this.watchScroll();
    } else if (this.term.element && this.term.element.parentElement !== host) {
      host.append(this.term.element);
    }
    this.fit();
  }

  detach() {
    if (this.term.element?.parentElement) this.term.element.remove();
  }

  /**
   * iOS autocorrect/autocapitalise would otherwise rewrite what you type into a
   * shell, and a sub-16px focused field makes Safari zoom the whole page.
   */
  hardenTextarea() {
    const ta = this.term.textarea;
    if (!ta) return;
    ta.setAttribute('autocorrect', 'off');
    ta.setAttribute('autocapitalize', 'none');
    ta.setAttribute('autocomplete', 'off');
    ta.setAttribute('spellcheck', 'false');
    ta.setAttribute('enterkeyhint', 'enter');
    ta.setAttribute('inputmode', 'text');
    ta.style.fontSize = '16px';
  }

  watchScroll() {
    const viewport = this.term.element?.querySelector('.xterm-viewport');
    if (!viewport) return;
    viewport.addEventListener('scroll', () => {
      this.emit('scroll', { atBottom: this.isAtBottom() });
    }, { passive: true });
  }

  isAtBottom() {
    const buf = this.term.buffer?.active;
    if (!buf) return true;
    return buf.viewportY >= buf.baseY - 1;
  }

  scrollToBottom() { this.term.scrollToBottom(); }

  focus() { this.term.focus(); }

  blur() { this.term.blur(); }

  isFocused() {
    const ta = this.term.textarea;
    return Boolean(ta && document.activeElement === ta);
  }

  setFontSize(px) {
    const size = Math.max(8, Math.min(22, px));
    this.term.options.fontSize = size;
    setFontSizePref(size);
    this.fit();
    return size;
  }

  /** Recompute cols/rows from the container. Guarded against 0-size layouts. */
  fit() {
    if (!this.opened || !this.term.element) return;
    const el = this.term.element;
    if (!el.isConnected || el.offsetWidth < 8 || el.offsetHeight < 8) return;
    let dims;
    try { dims = this.fitAddon.proposeDimensions(); } catch { return; }
    if (!dims) return;
    const { cols, rows } = dims;
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 2 || rows < 2) return;
    if (cols === this.term.cols && rows === this.term.rows) return;
    try { this.fitAddon.fit(); } catch { /* transient layout */ }
  }

  /* -------------------------------------------------------- connection */

  connect() {
    this.wantOpen = true;
    clearTimeout(this.retryTimer);
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) return;

    this.setState(this.everConnected ? 'reconnecting' : 'connecting');

    let ws;
    try {
      ws = new WebSocket(wsUrl(this.id), wsProtocols());
    } catch (err) {
      this.setState('error', String(err?.message || err));
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      const reconnected = this.everConnected;
      this.everConnected = true;
      this.setState('open');

      if (reconnected) {
        this.term.write('\r\n\x1b[2m── reconnected ──\x1b[0m\r\n');
      }

      this.fit();
      const { cols, rows } = this.lastSize.cols ? this.lastSize : { cols: this.term.cols, rows: this.term.rows };
      this.sendResize(cols, rows);
      this.flushPending();

      // Force the remote TUI to repaint. A size change raises SIGWINCH, which
      // makes full-screen apps (Claude Code included) redraw from scratch —
      // this is what stops a reattached session from showing a dead screen.
      clearTimeout(this.nudgeTimer);
      this.nudgeTimer = setTimeout(() => this.repaint(), 220);

      // Only call the connection healthy once it has survived a few seconds,
      // so a server that accepts-then-drops still backs off.
      clearTimeout(this.stableTimer);
      this.stableTimer = setTimeout(() => { this.attempt = 0; }, 2500);
    };

    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.lastActivity = Date.now();
      const data = ev.data;
      if (typeof data === 'string') {
        const control = parseControl(data);
        if (control) { this.handleControl(control); return; }
        this.term.write(data);
      } else if (data instanceof ArrayBuffer) {
        this.term.write(new Uint8Array(data));
      } else if (data instanceof Blob) {
        data.arrayBuffer().then((buf) => this.term.write(new Uint8Array(buf))).catch(() => {});
      }
    };

    ws.onerror = () => {
      if (this.ws !== ws) return;
      this.emit('error', { id: this.id });
    };

    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearTimeout(this.stableTimer);
      clearTimeout(this.nudgeTimer);

      if (!this.wantOpen) { this.setState('idle'); return; }

      if (AUTH_CLOSE_CODES.has(ev.code)) {
        this.wantOpen = false;
        this.setState('error', 'auth');
        window.dispatchEvent(new CustomEvent('cr:unauthorized'));
        return;
      }

      if (GONE_CLOSE_CODES.has(ev.code)) {
        this.wantOpen = false;
        this.setState('error', 'gone');
        this.emit('gone', { id: this.id });
        return;
      }

      if (ev.code === DETACHED_CLOSE_CODE) {
        // Someone detached this session (this phone, another viewer, or the
        // idle timer). tmux kept the session, so this is not an error — but
        // reconnecting automatically would defeat the point of detaching.
        this.wantOpen = false;
        this.setState('detached', ev.reason || 'detached');
        this.emit('detached', { id: this.id });
        return;
      }

      if (ev.code === BAD_REQUEST_CLOSE_CODE) {
        this.wantOpen = false;
        this.setState('error', ev.reason || 'rejected');
        return;
      }

      // The server rejects a bad token by refusing the HTTP upgrade, so the
      // browser reports only an opaque 1006 with no code of ours. Retrying is
      // right for a real network drop and wrong for a stale token, and the two
      // are indistinguishable from here — so ask the HTTP API which it is.
      if (!this.everConnected && OPAQUE_CLOSE_CODES.has(ev.code)) {
        this.classifyOpaqueFailure();
        return;
      }

      this.setState('closed', ev.reason || '');
      this.scheduleReconnect();
    };
  }

  /**
   * Distinguish "wrong token" from "Mac unreachable" after a handshake that
   * failed before producing a close code. One cheap authenticated GET settles
   * it; `request()` already fires cr:unauthorized on a 401/403.
   */
  async classifyOpaqueFailure() {
    this.setState('closed', 'handshake failed');
    try {
      await api.health({ timeout: 8000 });
    } catch (err) {
      if (err instanceof ApiError && err.isAuth) {
        this.wantOpen = false;
        this.setState('error', 'auth');
        return; // cr:unauthorized already dispatched by the request layer
      }
    }
    this.scheduleReconnect();
  }

  handleControl(msg) {
    switch (msg.type) {
      case 'attached':
      case 'ready':
        // Server accepted the attach and is about to send the scrollback replay.
        this.serverGeometry = { cols: msg.cols, rows: msg.rows };
        this.emit('attached', {
          id: this.id,
          cols: msg.cols,
          rows: msg.rows,
          subscribers: msg.subscribers,
        });
        break;

      case 'exit': {
        // `sessionAlive` distinguishes "the PTY viewer went away, tmux kept the
        // session" from "the program actually ended". Treating the first as a
        // dead session would wrongly drop a still-running agent off the list.
        const code = msg.exitCode ?? msg.code;
        const alive = Boolean(msg.sessionAlive);
        this.wantOpen = false;
        if (alive) {
          this.term.write('\r\n\x1b[2m── detached (session still running) ──\x1b[0m\r\n');
          this.setState('detached', 'detached');
          this.emit('detached', { id: this.id });
        } else {
          this.term.write(`\r\n\x1b[2m── session exited${code != null ? ` (${code})` : ''} ──\x1b[0m\r\n`);
          this.setState('error', 'exited');
          this.emit('gone', { id: this.id });
        }
        break;
      }

      case 'resize':
        // The PTY is shared, so another viewer can change the geometry under us.
        this.serverGeometry = { cols: msg.cols, rows: msg.rows };
        if (msg.reason === 'peer') {
          this.emit('geometry', { id: this.id, cols: msg.cols, rows: msg.rows });
        }
        break;

      case 'pong':
        if (Number.isFinite(msg.t)) this.latency = Date.now() - msg.t;
        break;

      case 'error':
        this.term.write(`\r\n\x1b[31m${String(msg.message || 'error')}\x1b[0m\r\n`);
        this.emit('server-error', { id: this.id, message: String(msg.message || 'error') });
        break;

      case 'info':
        break;

      default:
        break;
    }
  }

  scheduleReconnect() {
    if (!this.wantOpen) return;
    clearTimeout(this.retryTimer);
    const raw = Math.min(RECONNECT_MAX, RECONNECT_BASE * Math.pow(RECONNECT_FACTOR, this.attempt++));
    const delay = Math.round(raw * (0.75 + Math.random() * 0.5)); // jitter
    this.emit('retry', { in: delay, attempt: this.attempt });
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  /** Reconnect immediately — used when the tab comes back to the foreground. */
  reconnectNow() {
    if (!this.wantOpen) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    clearTimeout(this.retryTimer);
    this.attempt = 0;
    this.connect();
  }

  /**
   * Ask the server to drop this viewer while leaving the session running.
   * Falls back to a plain socket close when the server has no `detach` control.
   */
  requestDetach() {
    if (this.isOpen()) {
      try { this.ws.send(JSON.stringify({ type: 'detach' })); } catch { /* ignore */ }
    }
    this.disconnect();
  }

  disconnect() {
    this.wantOpen = false;
    clearTimeout(this.retryTimer);
    clearTimeout(this.stableTimer);
    clearTimeout(this.nudgeTimer);
    this.pending.length = 0;
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      try { ws.close(1000, 'client-detach'); } catch { /* ignore */ }
    }
    this.setState('idle');
  }

  isOpen() { return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN); }

  /* ------------------------------------------------------------- input */

  handleTyped(data) {
    const out = this.transform ? this.transform(data) : data;
    if (out) this.sendRaw(out);
  }

  sendRaw(data) {
    if (!data) return;
    if (this.isOpen()) {
      try {
        this.ws.send(JSON.stringify({ type: 'input', data }));
        return;
      } catch { /* fall through to queue */ }
    }
    this.queue(data);
    if (this.wantOpen) this.reconnectNow();
  }

  queue(data) {
    const now = Date.now();
    this.pending.push({ data, at: now });
    let total = 0;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      total += this.pending[i].data.length;
      if (total > PENDING_MAX) { this.pending.splice(0, i + 1); break; }
    }
  }

  flushPending() {
    if (!this.pending.length) return;
    const cutoff = Date.now() - PENDING_TTL;
    const fresh = this.pending.filter((item) => item.at >= cutoff);
    this.pending.length = 0;
    for (const item of fresh) {
      try { this.ws.send(JSON.stringify({ type: 'input', data: item.data })); } catch { break; }
    }
  }

  sendResize(cols, rows) {
    if (!this.isOpen()) return;
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 2 || rows < 2) return;
    try { this.ws.send(JSON.stringify({ type: 'resize', cols, rows })); } catch { /* ignore */ }
  }

  /** Nudge the PTY size so the remote app redraws the whole screen. */
  repaint() {
    if (!this.isOpen()) return;
    const cols = this.term.cols;
    const rows = this.term.rows;
    if (rows < 3) return;
    this.sendResize(cols, rows - 1);
    setTimeout(() => this.sendResize(cols, rows), 90);
  }

  dispose() {
    this.disconnect();
    this.listeners.clear();
    try { this.term.dispose(); } catch { /* ignore */ }
    this.opened = false;
  }
}

/**
 * Conservative control-frame detection: PTY output must not be mistaken for
 * JSON. Every type the server can send has to be listed here — an unlisted one
 * falls through to `term.write()` and paints raw JSON across the session.
 */
const CONTROL_TYPES = new Set([
  'attached', 'exit', 'error', 'resize', 'pong', 'ready', 'info',
]);

function parseControl(text) {
  if (text.length > 512 || text.charCodeAt(0) !== 123 /* { */) return null;
  if (!text.startsWith('{"type":"')) return null;
  let msg;
  try { msg = JSON.parse(text); } catch { return null; }
  if (!msg || typeof msg !== 'object' || !CONTROL_TYPES.has(msg.type)) return null;
  return msg;
}

/* ------------------------------------------------------------- registry */

const cache = new Map(); // id -> SessionTerm (insertion order = LRU)

export function getSessionTerm(id) {
  let term = cache.get(id);
  if (term) {
    cache.delete(id);
    cache.set(id, term); // bump to most-recent
    return term;
  }
  term = new SessionTerm(id);
  cache.set(id, term);
  evict(id);
  return term;
}

function evict(keepId) {
  while (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next().value;
    if (oldest === keepId) break;
    const victim = cache.get(oldest);
    cache.delete(oldest);
    victim?.dispose();
  }
}

export function dropSessionTerm(id) {
  const term = cache.get(id);
  if (term) { cache.delete(id); term.dispose(); }
}

export function disconnectAll() {
  for (const term of cache.values()) term.disconnect();
}
