/**
 * HTTP API.
 *
 * ┌─ SECURITY BOUNDARY ────────────────────────────────────────────────────┐
 * │ This API EXECUTES ARBITRARY COMMANDS ON THE USER'S MAC BY DESIGN.      │
 * │                                                                        │
 * │ `POST /api/sessions {command}` runs whatever string it is given, in a  │
 * │ login shell, as the user. That is not an oversight to be hardened away │
 * │ — it is the entire product. The user asked to be able to run any       │
 * │ terminal thing from their phone, and a `shell` session hands over an   │
 * │ interactive prompt regardless of what any allow-list here might say.   │
 * │                                                                        │
 * │ Therefore: THE BEARER TOKEN IS THE ONLY THING BETWEEN AN ATTACKER AND  │
 * │ A SHELL ON THIS MACHINE. There is no second line of defence, no        │
 * │ sandbox, and no command filtering worth writing (a filter that lets    │
 * │ `npm run dev` through lets `sh` through too).                          │
 * │                                                                        │
 * │ Consequences that must be preserved by anyone editing this file:       │
 * │   1. checkAuth() runs before ANY handler below, and before the         │
 * │      websocket handshake completes in ws-api.js. Never add a route     │
 * │      above that gate except an information-free liveness probe.        │
 * │   2. The listener never binds 0.0.0.0 (net.js enforces it), so reach   │
 * │      is limited to loopback and the tailnet.                           │
 * │   3. The token is never logged, never echoed in a response, and never  │
 * │      reflected back in a websocket subprotocol.                        │
 * │   4. Validation below exists to give clear ERRORS, not to contain a    │
 * │      hostile caller. A caller holding the token is already trusted     │
 * │      with the machine.                                                 │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * Route/id convention: session ids legitimately contain ':' and '/'
 * (e.g. "dormant:claude:-Users-tobiasdicker-movievault/e15d19df-…"), so ids
 * travel in the query string or a JSON body rather than as a path segment.
 * That removes a whole class of %2F-encoding bugs from the client.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { handleAssistantApi } from './assistant.js';
import { checkAuth } from './auth.js';
import { PROJECT_ROOT, TMUX_BIN, HARDENED_PATH, SAVED_COMMANDS_PATH } from './config.js';
import { listAllSessions, findSession, listProjects, parseId } from './discovery.js';
import { BARE_LAUNCH_KIND, DEFAULT_KIND, MAX_COMMAND_LENGTH, describeKinds, getKind, kindIds } from './kinds.js';
import { createSession, killSession, peekBroker, allBrokers } from './sessions.js';
import { setMeta, deleteMeta } from './meta.js';
import {
  LIMITS as COMMAND_LIMITS,
  ValidationError,
  createCommand,
  deleteCommand,
  getCommand,
  listCommands,
  noteRun,
  updateCommand,
} from './saved-commands.js';
import * as tmuxApi from './tmux.js';
import * as usage from './usage.js';
import { readPower } from './power.js';
import { log, summarize } from './util.js';

const MAX_BODY_BYTES = 64 * 1024;

/**
 * Directory the web client is served from. `public/` is where the client lives;
 * `client/` is accepted as a fallback so either layout works.
 */
let clientDirCache;
function clientDir() {
  if (clientDirCache !== undefined) return clientDirCache;
  for (const candidate of ['public', 'client']) {
    const full = path.join(PROJECT_ROOT, candidate);
    if (fs.existsSync(path.join(full, 'index.html'))) {
      clientDirCache = full;
      return clientDirCache;
    }
  }
  clientDirCache = null;
  return clientDirCache;
}

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function sendJson(res, status, payload) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    // This origin hands out a shell; never let another page frame or sniff it.
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * First non-empty trimmed string among the candidates, else null.
 * Every request field in this API has two accepted spellings (cwd/projectDir,
 * preset/kind, resumeId/resume); this collapses them at the point of use.
 */
function firstString(...candidates) {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return null;
}

/** Validate optional CLI args. They are shell-quoted before use. */
function normaliseArgs(input) {
  if (input == null) return [];
  if (!Array.isArray(input)) throw new Error('args must be an array of strings');
  if (input.length > 32) throw new Error('too many args');
  return input.map((a) => {
    if (typeof a !== 'string') throw new Error('args must be strings');
    if (a.length > 512) throw new Error('arg too long');
    if (a.includes('\0')) throw new Error('arg contains a null byte');
    return a;
  });
}

export function createHttpHandler({ bindInfo }) {
  return async function handle(req, res) {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      sendJson(res, 400, { error: 'bad request url' });
      return;
    }

    const { pathname } = url;

    // Unauthenticated liveness probe. Deliberately reveals nothing beyond
    // "a claude-remote server is here", so a client can distinguish
    // "unreachable" from "wrong token" while the tunnel is being set up.
    if (pathname === '/api/ping') {
      sendJson(res, 200, { ok: true, service: 'claude-remote' });
      return;
    }

    if (pathname.startsWith('/api/')) {
      const auth = checkAuth(req, url);
      if (!auth.ok) {
        sendJson(res, auth.status, { error: auth.error });
        return;
      }
      try {
        await handleApi(req, res, url, pathname, bindInfo);
      } catch (err) {
        log.error(`api error on ${pathname}:`, err);
        sendJson(res, 500, { error: err.message || 'internal error' });
      }
      return;
    }

    await serveStatic(req, res, pathname);
  };
}

async function handleApi(req, res, url, pathname, bindInfo) {
  const method = req.method || 'GET';

  /* -------------------- health -------------------- */
  if (pathname === '/api/health' && method === 'GET') {
    const sessions = await listAllSessions();
    const liveCount = sessions.filter((s) => s.status === 'live').length;
    const byKind = {};
    for (const s of sessions) {
      byKind[s.kind] = (byKind[s.kind] || 0) + 1;
    }
    sendJson(res, 200, {
      ok: true,
      service: 'claude-remote',
      bind: { host: bindInfo.host, port: bindInfo.port, reason: bindInfo.reason },
      tailscale: { ip: bindInfo.tailscaleIP, iface: bindInfo.iface, up: Boolean(bindInfo.tailscaleIP) },
      sessions: {
        total: sessions.length,
        live: liveCount,
        dormant: sessions.length - liveCount,
        byKind,
      },
      // On battery this Mac sleeps after 1 minute idle, which drops every session
      // with no explanation on the phone; on AC it never sleeps. Reporting it here
      // is what lets the client say "plug your Mac in" instead of just dying.
      power: await readPower().catch(() => null),
      kinds: describeKinds(),
      brokers: allBrokers().map((b) => ({
        name: b.name,
        subscribers: b.subscribers.size,
        hasPty: Boolean(b.pty),
        cols: b.cols,
        rows: b.rows,
      })),
      versions: {
        node: process.version,
        tmux: await tmuxApi.serverVersion(),
        tmuxBin: TMUX_BIN,
      },
      path: HARDENED_PATH,
      uptimeSeconds: Math.round(process.uptime()),
    });
    return;
  }

  /* -------------------- preset registry -------------------- *
   * `/api/presets` and `/api/kinds` are the same list under two names, and the
   * payload carries it under both keys. Unavailable presets are reported with
   * their reason rather than hidden — "codex is not installed" is far more
   * useful on a phone than a tile that silently is not there. */
  if ((pathname === '/api/presets' || pathname === '/api/kinds') && method === 'GET') {
    const presets = describeKinds();
    sendJson(res, 200, {
      presets,
      kinds: presets,
      default: DEFAULT_KIND,
      bare: BARE_LAUNCH_KIND,
    });
    return;
  }

  /* -------------------- saved commands -------------------- *
   * The user's own one-tap commands. Ids are `cmd_<12 hex>`, so unlike session
   * ids they are safe in a path segment; both /api/commands/<id> and
   * /api/commands?id=<id> are accepted. */
  if (pathname === '/api/commands' || pathname.startsWith('/api/commands/')) {
    const pathId = pathname.startsWith('/api/commands/')
      ? decodeURIComponent(pathname.slice('/api/commands/'.length))
      : null;

    if (pathId && pathId.includes('/')) {
      sendJson(res, 404, { error: 'no such endpoint' });
      return;
    }

    if (method === 'GET' && !pathId) {
      const commands = listCommands();
      sendJson(res, 200, { commands, count: commands.length, limits: COMMAND_LIMITS });
      return;
    }

    if (method === 'GET' && pathId) {
      const found = getCommand(pathId);
      if (!found) {
        sendJson(res, 404, { error: `no saved command with id ${pathId}` });
        return;
      }
      sendJson(res, 200, { command: found });
      return;
    }

    if (method === 'POST' && !pathId) {
      const body = await readBody(req);
      try {
        const created = createCommand(body);
        sendJson(res, 201, { command: created });
      } catch (err) {
        if (err instanceof ValidationError) sendJson(res, 400, { error: err.message });
        else throw err;
      }
      return;
    }

    if ((method === 'PATCH' || method === 'PUT') && (pathId || url.searchParams.get('id'))) {
      const id = pathId || url.searchParams.get('id');
      const body = await readBody(req);
      try {
        const updated = updateCommand(id, body);
        if (!updated) {
          sendJson(res, 404, { error: `no saved command with id ${id}` });
          return;
        }
        sendJson(res, 200, { command: updated });
      } catch (err) {
        if (err instanceof ValidationError) sendJson(res, 400, { error: err.message });
        else throw err;
      }
      return;
    }

    if (method === 'DELETE' && (pathId || url.searchParams.get('id'))) {
      const id = pathId || url.searchParams.get('id');
      if (!deleteCommand(id)) {
        sendJson(res, 404, { error: `no saved command with id ${id}` });
        return;
      }
      sendJson(res, 200, { ok: true, deleted: id });
      return;
    }

    sendJson(res, 405, { error: `method ${method} not allowed on ${pathname}` });
    return;
  }

  /* -------------------- list / get -------------------- */
  if (pathname === '/api/sessions' && method === 'GET') {
    const id = url.searchParams.get('id');
    if (id) {
      const found = await findSession(id);
      if (!found) {
        sendJson(res, 404, { error: 'session not found' });
        return;
      }
      sendJson(res, 200, { session: found });
      return;
    }

    let sessions = await listAllSessions();
    const total = sessions.length;

    const kindFilter = url.searchParams.get('kind');
    if (kindFilter) {
      const wanted = new Set(kindFilter.split(',').map((k) => k.trim()).filter(Boolean));
      const unknown = [...wanted].filter((k) => !getKind(k));
      if (unknown.length) {
        sendJson(res, 400, { error: `unknown kind(s): ${unknown.join(', ')}`, known: kindIds() });
        return;
      }
      sessions = sessions.filter((s) => wanted.has(s.kind));
    }

    const statusFilter = url.searchParams.get('status');
    if (statusFilter) {
      if (statusFilter !== 'live' && statusFilter !== 'dormant') {
        sendJson(res, 400, { error: 'status must be "live" or "dormant"' });
        return;
      }
      sessions = sessions.filter((s) => s.status === statusFilter);
    }

    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    if (q) {
      sessions = sessions.filter((s) =>
        `${s.label} ${s.preview} ${s.projectDir || ''}`.toLowerCase().includes(q),
      );
    }

    const matched = sessions.length;
    const limit = Number.parseInt(url.searchParams.get('limit') || '', 10);
    if (Number.isFinite(limit) && limit > 0) sessions = sessions.slice(0, limit);

    sendJson(res, 200, {
      sessions,
      count: sessions.length,
      matched,
      total,
      kinds: describeKinds(),
    });
    return;
  }

  /* -------------------- projects -------------------- */
  if (pathname === '/api/projects' && method === 'GET') {
    sendJson(res, 200, { projects: await listProjects() });
    return;
  }

  /* -------------------- token usage -------------------- *
   * Read-only accounting over the transcripts on disk. usage.js opens those
   * files for reading only and caches by (size, mtime), so these routes never
   * write to ~/.claude/projects or ~/.codex.
   *
   * Every cost here is an ESTIMATE derived from the user-editable price table
   * (usage-prices.json); the payloads say so in `cost.estimated` and
   * `prices.note`, and the client must keep saying so. Token buckets stay
   * separate all the way to the wire — input, output, cacheRead and cacheWrite
   * are priced an order of magnitude apart, so a single "tokens" figure would
   * misrepresent spend rather than summarise it.
   *
   * Session ids contain '/' (`<projectDirName>/<uuid>`), so per the route
   * convention at the top of this file the id may travel either as a
   * percent-encoded path segment or as `?id=`. */
  if (pathname === '/api/usage' || pathname.startsWith('/api/usage/')) {
    const window = usage.normaliseWindow(url.searchParams.get('window'));

    if (pathname === '/api/usage' && method === 'GET') {
      sendJson(res, 200, await usage.overview({ window }));
      return;
    }

    if (pathname === '/api/usage/projects' && method === 'GET') {
      sendJson(res, 200, await usage.projectUsage({ window }));
      return;
    }

    if (pathname === '/api/usage/sessions' && method === 'GET') {
      const limit = Number.parseInt(url.searchParams.get('limit') || '', 10);
      sendJson(res, 200, await usage.sessionSummaries({
        window,
        ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
      }));
      return;
    }

    const sessionMatch = /^\/api\/usage\/session\/(.+)$/.exec(pathname);
    if ((sessionMatch || pathname === '/api/usage/session') && method === 'GET') {
      const id = sessionMatch ? decodeURIComponent(sessionMatch[1]) : url.searchParams.get('id');
      if (!id) {
        sendJson(res, 400, { error: 'a session id is required — /api/usage/session/<id> or ?id=<id>' });
        return;
      }
      const found = await usage.sessionUsage(id, { window });
      if (!found) {
        sendJson(res, 404, { error: `no transcript usage recorded for ${id}` });
        return;
      }
      sendJson(res, 200, found);
      return;
    }

    // Codex ships no cache-write/read split and no list price, so this reports
    // what it genuinely has and says plainly that cost is unavailable. The
    // client must render that as "unavailable", never as a zero.
    if (pathname === '/api/usage/codex' && method === 'GET') {
      sendJson(res, 200, await usage.codexUsage({ id: url.searchParams.get('id') || null }));
      return;
    }

    if (pathname === '/api/usage/prices' && method === 'GET') {
      sendJson(res, 200, usage.prices());
      return;
    }

    // Forces a re-read of every transcript, bypassing the (size, mtime) cache.
    if (pathname === '/api/usage/refresh' && method === 'POST') {
      sendJson(res, 200, { ok: true, scan: await usage.refresh() });
      return;
    }

    sendJson(res, 404, { error: 'no such endpoint' });
    return;
  }

  /* -------------------- local AI helper -------------------- *
   * The whole /api/assistant/ subtree lives in assistant.js — it streams SSE
   * rather than returning JSON, and it owns its own single-flight rule. It
   * NEVER executes anything: a command the model writes reaches a shell only
   * when the user taps Run, which comes back through POST /api/sessions below
   * like any other hand-typed command. Returns false if the path is not its. */
  if (pathname === '/api/assistant' || pathname.startsWith('/api/assistant/')) {
    if (await handleAssistantApi({ req, res, url, pathname, method, readBody, sendJson })) return;
  }

  /* -------------------- create -------------------- *
   * ONE endpoint launches everything:
   *
   *   {command}          run exactly that command line in a PTY (kind `custom`)
   *   {preset}           expand a registry entry (`claude`, `codex`, …)
   *   {savedCommandId}   run one of the user's saved commands
   *   {resumeId}         resume a dormant session; its kind comes from the id
   *   {}                 a login shell — the universal escape hatch
   *
   * `preset` and `kind` are the same field under two names, as are `cwd` and
   * `projectDir`, and `resumeId` and `resume`. Both spellings are accepted so
   * the client never has to guess which vintage of the server it is talking to.
   */
  if (pathname === '/api/sessions' && method === 'POST') {
    const body = await readBody(req);

    let args;
    try {
      args = normaliseArgs(body.args);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
      return;
    }

    let kindId = firstString(body.preset, body.kind);
    let resumeId = null;
    let target = null;
    let command = null;
    let saved = null;

    /* ---- saved command, if one was named ---- */
    const savedId = firstString(body.savedCommandId, body.commandId);
    if (savedId) {
      saved = getCommand(savedId);
      if (!saved) {
        sendJson(res, 404, { error: `no saved command with id ${savedId}` });
        return;
      }
      command = saved.command;
    }

    /* ---- an explicit command overrides a saved one ---- */
    const bodyCommand = firstString(body.command);
    if (bodyCommand) command = bodyCommand;

    if (command != null) {
      if (command.length > MAX_COMMAND_LENGTH) {
        sendJson(res, 400, { error: `command must be at most ${MAX_COMMAND_LENGTH} characters` });
        return;
      }
      if (command.includes('\0')) {
        sendJson(res, 400, { error: 'command must not contain a null byte' });
        return;
      }
      if (kindId && kindId !== 'custom') {
        sendJson(res, 400, {
          error: `cannot combine command with preset "${kindId}" — a command always runs as the "custom" preset`,
        });
        return;
      }
      kindId = 'custom';
    }

    /* ---- resuming: a dormant id from the list, or a raw tool-native id ---- */
    const resumeInput = firstString(body.resumeId, body.resume);
    if (resumeInput) {
      if (command) {
        sendJson(res, 400, { error: 'a command session cannot be resumed — send either command or resumeId' });
        return;
      }

      const parsed = parseId(resumeInput);

      if (parsed?.status === 'live') {
        sendJson(res, 400, {
          error: 'that session is already live — open a websocket to it instead of resuming',
        });
        return;
      }

      if (parsed?.status === 'dormant') {
        if (kindId && kindId !== parsed.kind) {
          sendJson(res, 400, {
            error: `preset "${kindId}" does not match the kind in resume id ("${parsed.kind}")`,
          });
          return;
        }
        kindId = parsed.kind;
        target = await findSession(resumeInput);
        if (!target) {
          sendJson(res, 404, { error: `no dormant session with id ${resumeInput}` });
          return;
        }
        resumeId = target.resumeId;
      } else {
        // Raw tool-native id with no kind stated. Claude is the assumed tool
        // because its ids are the ones users paste from `/resume` output.
        kindId = kindId || DEFAULT_KIND;
        resumeId = resumeInput;
      }
    }

    // Nothing asked for at all: hand over a shell rather than guessing a tool.
    kindId = kindId || BARE_LAUNCH_KIND;
    const kind = getKind(kindId);
    if (!kind) {
      sendJson(res, 400, { error: `unknown preset "${kindId}"`, known: kindIds() });
      return;
    }
    if (kind.requiresCommand && !command) {
      sendJson(res, 400, { error: `preset "${kindId}" needs a command — send {command:"…"}` });
      return;
    }

    /* ---- working directory ---- */
    let cwd = firstString(body.cwd, body.projectDir) || saved?.cwd || target?.projectDir || os.homedir();
    cwd = path.resolve(cwd);
    try {
      const st = await fsp.stat(cwd);
      if (!st.isDirectory()) throw new Error('not a directory');
    } catch {
      sendJson(res, 400, { error: `cwd is not an existing directory: ${cwd}` });
      return;
    }

    const label =
      firstString(body.label) ||
      saved?.name ||
      target?.label ||
      (command ? summarize(command, 32) : path.basename(cwd)) ||
      kindId;

    let created;
    try {
      created = await createSession({ kind: kindId, projectDir: cwd, resumeId, args, label, command });
    } catch (err) {
      const status = err.code === 'BIN_NOT_FOUND' ? 503 : 400;
      sendJson(res, status, { error: err.message, kind: kindId });
      return;
    }

    if (saved) noteRun(saved.id);

    setMeta(created.name, {
      kind: kindId,
      projectDir: cwd,
      resumedFrom: resumeId,
      args,
      label,
      command,
      savedCommandId: saved?.id || null,
      // For a command session the command itself is the most useful preview
      // line in the session list; for a resumed one it is the old prompt.
      preview: command || target?.preview || '',
      binPath: created.binPath,
      createdAt: Date.now(),
    });

    const session = await findSession(`live:${created.name}`);
    sendJson(res, 201, {
      id: `live:${created.name}`,
      tmuxName: created.name,
      kind: kindId,
      preset: kindId,
      command,
      savedCommandId: saved?.id || null,
      resumedFrom: resumeId,
      cwd,
      session,
    });
    return;
  }

  /* -------------------- kill / detach -------------------- *
   * Two spellings each. The body form (`/api/sessions/kill` with {id}) is the
   * primary one because session ids contain ':' and '/'. The path form is
   * accepted too, for clients that reach for REST shapes first — the id must
   * then be percent-encoded whole, which is why the pattern below refuses an
   * id containing a literal '/'. */
  const actionMatch = /^\/api\/sessions\/(.+)\/(kill|detach)$/.exec(pathname);
  if (actionMatch && method === 'POST') {
    const rawId = decodeURIComponent(actionMatch[1]);
    await sessionAction(res, actionMatch[2], rawId);
    return;
  }

  if ((pathname === '/api/sessions/kill' || pathname === '/api/sessions/detach') && method === 'POST') {
    const body = await readBody(req);
    const action = pathname.endsWith('/kill') ? 'kill' : 'detach';
    await sessionAction(res, action, body.id);
    return;
  }

  sendJson(res, 404, { error: 'no such endpoint' });
}

/**
 * Kill destroys the tmux session; detach only drops the PTY and boots the
 * viewers, leaving the user's work running. Both take a `live:` id.
 */
async function sessionAction(res, action, id) {
  const parsed = parseId(id);
  if (parsed?.status !== 'live') {
    sendJson(res, 400, { error: `${action} requires a live session id (live:<tmux-name>)` });
    return;
  }

  if (!(await tmuxApi.hasSession(parsed.tmuxName))) {
    sendJson(res, 404, { error: 'session not found' });
    return;
  }

  if (action === 'kill') {
    await killSession(parsed.tmuxName);
    deleteMeta(parsed.tmuxName);
    sendJson(res, 200, { ok: true, killed: parsed.tmuxName });
    return;
  }

  const broker = peekBroker(parsed.tmuxName);
  let closed = 0;
  if (broker) {
    // Tell every attached viewer why their stream ended, then drop the PTY.
    for (const sub of [...broker.subscribers]) {
      closed += 1;
      sub.close(4002, 'detached');
    }
    broker.detach();
  }
  const stillAlive = await tmuxApi.hasSession(parsed.tmuxName);
  sendJson(res, 200, { ok: true, detached: parsed.tmuxName, closedClients: closed, sessionAlive: stillAlive });
}

/* ------------------------------------------------------------------ *
 * Static client
 * ------------------------------------------------------------------ */

async function serveStatic(req, res, pathname) {
  const root = clientDir();
  if (!root) {
    sendJson(res, 404, {
      error: 'no client build present',
      hint: `place static files in ${path.join(PROJECT_ROOT, 'public')}`,
    });
    return;
  }

  const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  const target = path.resolve(root, `.${rel}`);

  // Containment check: refuse anything that escapes the client directory.
  if (target !== root && !target.startsWith(root + path.sep)) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }

  try {
    const st = await fsp.stat(target);
    if (st.isDirectory()) {
      await serveStatic(req, res, path.posix.join(pathname, 'index.html'));
      return;
    }
    const data = await fsp.readFile(target);
    res.writeHead(200, {
      'Content-Type': STATIC_TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: 'not found' });
  }
}
