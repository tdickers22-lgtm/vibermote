/**
 * HTTP + WebSocket client.
 *
 * AUTH: the bearer token never appears in a URL for HTTP requests — those use
 * `Authorization: Bearer <token>`. The browser WebSocket API cannot set headers,
 * so the token rides in `Sec-WebSocket-Protocol` as `bearer.<token>`, which the
 * server reads off the upgrade request. Tokens containing characters that are
 * illegal in a subprotocol fall back to the `?token=` query parameter, because
 * `new WebSocket(url, badProtocol)` throws SyntaxError rather than failing soft.
 *
 * SHAPE TOLERANCE: every response passes through a normaliser. The server is
 * being generalised in parallel and the copy on disk disagrees with the agreed
 * contract in several places (see the integration report), so the client accepts
 * both spellings rather than hard-failing on whichever half lands first.
 */

import { inferKind, KIND_IDS } from './kinds.js';

const TOKEN_KEY = 'claude-remote:token';

/** Subprotocol values are RFC-7230 tokens: no spaces, no separators. */
const SUBPROTOCOL_SAFE = /^[A-Za-z0-9._~-]+$/;

export const WS_SUBPROTOCOL = 'claude-remote.v1';

let token = '';
try {
  token = localStorage.getItem(TOKEN_KEY) || '';
} catch {
  /* private mode / storage blocked — run tokenless, user re-enters each launch */
}

export function getToken() { return token; }

export function setToken(value) {
  token = value || '';
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* ignore */ }
}

export function clearToken() { setToken(''); }

export function hasToken() { return Boolean(token); }

/** True when the token can be carried in a WebSocket subprotocol as-is. */
export function tokenIsSubprotocolSafe(value = token) {
  return SUBPROTOCOL_SAFE.test(value || '');
}

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
  get isAuth() { return this.status === 401 || this.status === 403; }
  get isMissingEndpoint() { return this.status === 404 || this.status === 405; }
}

function notifyUnauthorized() {
  window.dispatchEvent(new CustomEvent('cr:unauthorized'));
}

async function request(path, { method = 'GET', body, timeout = 15000, auth = true } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  const headers = {};
  if (auth && token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'omit',
    });
  } catch (err) {
    clearTimeout(timer);
    if (err?.name === 'AbortError') throw new ApiError('Request timed out', 0);
    throw new ApiError('Cannot reach the server', 0);
  }
  clearTimeout(timer);

  const text = await res.text().catch(() => '');
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = text; }
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) notifyUnauthorized();
    const message =
      (payload && typeof payload === 'object' && (payload.error || payload.message)) ||
      (typeof payload === 'string' && payload.slice(0, 200)) ||
      `Request failed (${res.status})`;
    throw new ApiError(message, res.status, payload);
  }

  return payload;
}

/* ------------------------------------------------------------------ *
 * Normalisation
 * ------------------------------------------------------------------ */

/**
 * Fold a server session into the shape the UI renders:
 *   { id, kind, label, cwd, live, lastActivity, preview, resumeId, raw }
 *
 * Tolerated inputs:
 *   live      — boolean (contract) OR an object/null (server on disk)
 *   status    — 'live' | 'dormant' (server on disk)
 *   cwd       — `cwd` (contract) OR `projectDir` (server on disk)
 *   kind      — a CLI kind (contract) OR 'live'/'dormant' (server on disk, which
 *               overloads the field); the latter is discarded and re-inferred.
 */
export function normaliseSession(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id : null;
  if (!id) return null;

  let live;
  if (typeof raw.live === 'boolean') live = raw.live;
  else if (typeof raw.status === 'string') live = raw.status === 'live';
  else live = Boolean(raw.live);

  const cwd = raw.cwd || raw.projectDir || raw.dir || '';

  const declared = String(raw.kind || '').toLowerCase();
  const kind = KIND_IDS.has(declared) ? declared : inferKind(raw);

  const resumeId =
    raw.resumeId || raw.resume || raw.dormant?.sessionId || null;

  return {
    id,
    kind,
    label: typeof raw.label === 'string' && raw.label ? raw.label : '',
    cwd,
    live,
    lastActivity: raw.lastActivity ?? raw.activityAt ?? raw.updatedAt ?? 0,
    preview: typeof raw.preview === 'string' ? raw.preview : '',
    resumeId,
    gitBranch: raw.gitBranch || null,
    raw,
  };
}

function normaliseList(payload) {
  const list = Array.isArray(payload?.sessions) ? payload.sessions
    : Array.isArray(payload) ? payload
    : [];
  return list.map(normaliseSession).filter(Boolean);
}

/**
 * Fold a saved command into { id, name, command, cwd, icon, color, lastRunAt,
 * runCount }. A record without a command string is unlaunchable, so it is
 * dropped rather than rendered as a tile that cannot do anything.
 */
export function normaliseCommand(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id : '';
  const command = typeof raw.command === 'string' ? raw.command.trim() : '';
  if (!id || !command) return null;
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : command;
  return {
    id,
    name,
    command,
    cwd: raw.cwd || raw.projectDir || '',
    icon: typeof raw.icon === 'string' ? raw.icon : '',
    color: typeof raw.color === 'string' ? raw.color : '',
    lastRunAt: raw.lastRunAt ?? 0,
    runCount: Number.isFinite(raw.runCount) ? raw.runCount : 0,
  };
}

/* ------------------------------------------------------------------ *
 * Endpoints
 * ------------------------------------------------------------------ */

export const api = {
  health: (opts) => request('/api/health', opts),

  async listSessions() {
    return normaliseList(await request('/api/sessions'));
  },

  /**
   * `GET /api/terminal-windows`. The Mac's real Terminal windows, already
   * ordered by project then CLI, each carrying the text on its screen. These
   * are mirrors: none of them can be attached to.
   */
  async listTerminalWindows() {
    const payload = await request('/api/terminal-windows');
    return Array.isArray(payload?.windows) ? payload.windows : [];
  },

  /**
   * Type into one of the Mac's Terminal windows. `text` is typed and, unless
   * `submit` is false, followed by Return; `key` sends a single named key or
   * control combination instead ('escape', 'up', 'ctrl+c', …).
   *
   * This focuses that window on the Mac in order to type into it, which is
   * unavoidable for a process Vibermote did not start. See
   * scripts/terminal-input.js.
   */
  sendTerminalInput({ windowId, text, key, submit = true }) {
    return request('/api/terminal-windows/input', {
      method: 'POST',
      body: key ? { windowId, key } : { windowId, text, submit },
    });
  },

  /** Open a new Terminal window on the Mac, optionally in a directory. */
  openTerminalWindow({ cwd = '', command = '' } = {}) {
    return request('/api/terminal-windows', { method: 'POST', body: { cwd, command } });
  },

  /**
   * One session by id. Used by the notification deep link, where the id arrives
   * from outside the app and the list may not have loaded yet. A 404 means the
   * session ended while the notification sat on the lock screen, which is an
   * ordinary outcome rather than an error.
   */
  async getSession(id) {
    try {
      const payload = await request(`/api/sessions?id=${encodeURIComponent(id)}`);
      return normaliseSession(payload?.session || payload);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  },

  /**
   * `GET /api/kinds`. Returns null when the server has no such endpoint, which
   * is the current state on disk — callers keep the built-in registry.
   */
  async listKinds() {
    try {
      const payload = await request('/api/kinds');
      return Array.isArray(payload?.kinds) ? payload.kinds
        : Array.isArray(payload) ? payload
        : null;
    } catch (err) {
      if (err instanceof ApiError && err.isMissingEndpoint) return null;
      throw err;
    }
  },

  /**
   * `GET /api/env` — this Mac's home directory and tmux prefix. Optional: a
   * server without it leaves the client on its documented defaults rather than
   * failing, so `null` is a valid answer and not an error.
   */
  async env() {
    try {
      return await request('/api/env', { timeout: 8000 });
    } catch (err) {
      if (err instanceof ApiError && err.isMissingEndpoint) return null;
      throw err;
    }
  },

  /**
   * Recently used project directories. Optional endpoint — an absent one just
   * means the directory picker falls back to dirs mined from the session list.
   */
  async listProjects() {
    try {
      const payload = await request('/api/projects');
      const list = Array.isArray(payload?.projects) ? payload.projects
        : Array.isArray(payload) ? payload
        : [];
      return list
        .map((p) => (typeof p === 'string' ? { cwd: p, lastActivity: 0 } : {
          cwd: p?.cwd || p?.projectDir || '',
          lastActivity: p?.lastActivity || 0,
          sessions: p?.sessions || 0,
        }))
        .filter((p) => p.cwd);
    } catch (err) {
      if (err instanceof ApiError && err.isMissingEndpoint) return [];
      throw err;
    }
  },

  /**
   * Create a session. The body carries both spellings of every field so it
   * satisfies the agreed contract ({kind, cwd, resumeId}) and the server on
   * disk ({projectDir, resume, args, label}) without a round of negotiation.
   *
   * `command` is the one that makes this product what it is: any string here is
   * run in a login shell as a `custom` session, so the phone is not limited to
   * the CLIs in the kind registry. A command always forces the `custom` preset
   * — the server rejects `{command, preset:"claude"}` outright — so any kind the
   * caller passed alongside one is overridden rather than sent and refused.
   *
   * `savedCommandId` launches one of the user's stored commands; the server
   * looks up its command line, labels the session with its name, and bumps its
   * run counter. Sending the id (rather than the resolved text) is what keeps
   * that bookkeeping correct.
   */
  async createSession({ kind, cwd, resumeId, args, label, command, savedCommandId } = {}) {
    const body = {};
    if (cwd) { body.cwd = cwd; body.projectDir = cwd; }

    const line = typeof command === 'string' ? command.trim() : '';
    if (line) body.command = line;
    if (savedCommandId) { body.savedCommandId = savedCommandId; body.commandId = savedCommandId; }

    // preset and kind are the same field under two names; send both spellings.
    const preset = (line || savedCommandId) ? 'custom' : kind;
    if (preset) { body.kind = preset; body.preset = preset; }

    if (resumeId) { body.resumeId = resumeId; body.resume = resumeId; }
    if (Array.isArray(args) && args.length) body.args = args;
    if (label) body.label = label;

    const payload = await request('/api/sessions', { method: 'POST', body, timeout: 25000 });
    const id = payload?.id || payload?.session?.id || null;
    if (!id) throw new ApiError('Server did not return a session id', 0, payload);
    return { id, session: normaliseSession(payload?.session) };
  },

  /* ------------------------------------------------------- saved commands *
   * The user's own one-tap command tiles. `GET` tolerates a server without the
   * endpoint by returning an empty list — the command field above still works,
   * so the feature degrades to "type it every time" rather than breaking the
   * sheet. Writes do not swallow anything: a failed save must be visible. */

  async listCommands() {
    try {
      const payload = await request('/api/commands');
      const list = Array.isArray(payload?.commands) ? payload.commands
        : Array.isArray(payload) ? payload
        : [];
      return list.map(normaliseCommand).filter(Boolean);
    } catch (err) {
      if (err instanceof ApiError && err.isMissingEndpoint) return [];
      throw err;
    }
  },

  async saveCommand({ name, command, cwd, icon, color } = {}) {
    const body = { name, command };
    if (cwd) body.cwd = cwd;
    if (icon) body.icon = icon;
    if (color) body.color = color;
    const payload = await request('/api/commands', { method: 'POST', body });
    const saved = normaliseCommand(payload?.command || payload);
    if (!saved) throw new ApiError('Server did not return the saved command', 0, payload);
    return saved;
  },

  async updateCommand(id, patch = {}) {
    const payload = await request(`/api/commands/${encodeURIComponent(id)}`, {
      method: 'PATCH', body: patch,
    });
    return normaliseCommand(payload?.command || payload);
  },

  /** Ids are `cmd_<12 hex>` — no ':' or '/', so the path form is always safe. */
  deleteCommand: (id) =>
    request(`/api/commands/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /**
   * Kill a session. Tries the contract's path form first, then falls back to
   * the body form the server on disk exposes. The fallback matters: ids contain
   * ':' and '/', which is exactly why that server moved the id into the body.
   */
  async killSession(id) {
    try {
      return await request(`/api/sessions/${encodeURIComponent(id)}/kill`, { method: 'POST' });
    } catch (err) {
      if (!(err instanceof ApiError) || !err.isMissingEndpoint) throw err;
      return request('/api/sessions/kill', { method: 'POST', body: { id } });
    }
  },

  /** Detach every viewer but leave the session running. Optional endpoint. */
  async detachSession(id) {
    try {
      return await request('/api/sessions/detach', { method: 'POST', body: { id } });
    } catch (err) {
      if (err instanceof ApiError && err.isMissingEndpoint) return null;
      throw err;
    }
  },

  /* ---------------------------------------------------------------- usage *
   * Deliberately unnormalised: the usage payloads keep input / output /
   * cacheRead / cacheWrite apart because they are priced an order of magnitude
   * apart, and a normaliser is exactly the place where someone would be
   * tempted to fold them into one "tokens" number. The view renders the
   * server's shape as-is.
   *
   * A cold scan of a couple of thousand transcripts takes a few seconds, so
   * these get a longer timeout than the rest of the API. */

  usage: (window = 'all') =>
    request(`/api/usage?window=${encodeURIComponent(window)}`, { timeout: 45000 }),

  usageProjects: (window = 'all') =>
    request(`/api/usage/projects?window=${encodeURIComponent(window)}`, { timeout: 45000 }),

  usageSession: (id, window = 'all') =>
    request(`/api/usage/session/${encodeURIComponent(id)}?window=${encodeURIComponent(window)}`, {
      timeout: 45000,
    }),

  usagePrices: () => request('/api/usage/prices'),

  /**
   * Codex accounting. Never throws for "no data" — it returns the server's own
   * explanation, which the view shows instead of a misleading zero.
   */
  async usageCodex() {
    try {
      return await request('/api/usage/codex', { timeout: 45000 });
    } catch (err) {
      if (err instanceof ApiError && err.isMissingEndpoint) return null;
      throw err;
    }
  },

  /** Re-read transcripts that changed on disk. */
  usageRefresh: () => request('/api/usage/refresh', { method: 'POST', timeout: 90000 }),

  /* --------------------------------------------------------------- push *
   * Notifications for "the agent finished" and "the agent is waiting for you".
   * Authenticated like everything else — the bearer token rides in the
   * Authorization header via request(), including on subscribe.
   *
   * A server too old to have these routes reports "off" rather than throwing,
   * so the settings sheet says "not available" instead of showing an error. */

  /** The VAPID public key the browser needs to subscribe. Public by design. */
  pushKey: () => request('/api/push/key'),

  async pushStatus() {
    try {
      return await request('/api/push/status');
    } catch (err) {
      if (err instanceof ApiError && err.isMissingEndpoint) return { enabled: false, count: 0, subscriptions: [] };
      throw err;
    }
  },

  /** `subscription.toJSON()` straight from the PushManager. */
  pushSubscribe: (subscription) =>
    request('/api/push/subscribe', { method: 'POST', body: subscription }),

  pushUnsubscribe: (endpoint) =>
    request('/api/push/unsubscribe', { method: 'POST', body: { endpoint } }),

  pushTest: () => request('/api/push/test', { method: 'POST', timeout: 20000 }),
};

/** Validate a candidate token without persisting it. */
export async function verifyToken(candidate) {
  const previous = token;
  token = candidate;
  try {
    await request('/api/health', { timeout: 10000 });
    return true;
  } finally {
    token = previous;
  }
}

/**
 * Unauthenticated liveness probe. Lets the UI tell "the Mac is unreachable"
 * apart from "the token is wrong", which are very different fixes for the user.
 */
export async function pingServer() {
  try {
    await request('/api/ping', { auth: false, timeout: 6000 });
    return true;
  } catch {
    return false;
  }
}

export function wsUrl(sessionId) {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const base = `${scheme}//${location.host}/ws?session=${encodeURIComponent(sessionId)}`;
  // Only when the token cannot ride in the subprotocol — see wsProtocols().
  if (token && !tokenIsSubprotocolSafe()) {
    return `${base}&token=${encodeURIComponent(token)}`;
  }
  return base;
}

/**
 * Subprotocols offered on the handshake. The server validates the `bearer.`
 * entry; it need not echo a selection back (a server that selects nothing is
 * accepted by browsers, and `ws` omits the response header by default).
 */
export function wsProtocols() {
  if (!token || !tokenIsSubprotocolSafe()) return [WS_SUBPROTOCOL];
  return [WS_SUBPROTOCOL, `bearer.${token}`];
}
