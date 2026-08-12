/**
 * Bearer-token auth for both HTTP requests and the websocket upgrade.
 *
 * This endpoint hands out a shell on the user's dev machine, so auth is
 * load-bearing: every path that can reach a PTY goes through requireAuth().
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { TOKEN_PATH, AUTH_MAX_FAILURES, AUTH_LOCKOUT_MS } from './config.js';
import { log, registerSecret, timingSafeEqual } from './util.js';

let TOKEN = null;

/**
 * Load the token, generating it on first run. The file is created with 0600 and
 * its permissions are re-asserted on every start in case they drifted.
 */
export function loadOrCreateToken() {
  let token = null;

  if (fs.existsSync(TOKEN_PATH)) {
    token = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
    if (!token) {
      log.warn('token file was empty; regenerating');
      token = null;
    }
  }

  let created = false;
  if (!token) {
    token = crypto.randomBytes(32).toString('hex');
    // wx + 0600 so the secret is never briefly world-readable.
    fs.writeFileSync(TOKEN_PATH, `${token}\n`, { mode: 0o600, flag: 'w' });
    created = true;
  }

  fs.chmodSync(TOKEN_PATH, 0o600);

  TOKEN = token;
  registerSecret(token); // never let it reach a log line
  return { created, path: TOKEN_PATH };
}

export function getToken() {
  if (!TOKEN) throw new Error('token not initialised — call loadOrCreateToken() first');
  return TOKEN;
}

/* ------------------------------------------------------------------ *
 * Failed-attempt throttling, keyed by source IP.
 * ------------------------------------------------------------------ */

const failures = new Map(); // ip -> { count, until }

function ipOf(req) {
  return req.socket?.remoteAddress || 'unknown';
}

function isLockedOut(ip) {
  const entry = failures.get(ip);
  if (!entry) return false;
  if (entry.until && Date.now() < entry.until) return true;
  if (entry.until && Date.now() >= entry.until) {
    failures.delete(ip);
  }
  return false;
}

function noteFailure(ip) {
  const entry = failures.get(ip) || { count: 0, until: 0 };
  entry.count += 1;
  if (entry.count >= AUTH_MAX_FAILURES) {
    entry.until = Date.now() + AUTH_LOCKOUT_MS;
    entry.count = 0;
    log.warn(`auth: locking out ${ip} for ${AUTH_LOCKOUT_MS}ms after repeated failures`);
  }
  failures.set(ip, entry);
}

function noteSuccess(ip) {
  failures.delete(ip);
}

/**
 * Extract a presented token from a request.
 *
 * Browsers cannot set an Authorization header on a WebSocket, so the query
 * parameter is a hard requirement rather than a convenience. The
 * Sec-WebSocket-Protocol form is supported for clients that prefer to keep the
 * secret out of the URL (and therefore out of server access logs).
 */
export function extractToken(req, url) {
  const header = req.headers['authorization'];
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice(7).trim();
  }

  const proto = req.headers['sec-websocket-protocol'];
  if (typeof proto === 'string') {
    for (const part of proto.split(',')) {
      const v = part.trim();
      if (v.startsWith('bearer.')) return v.slice(7);
    }
  }

  const qp = url?.searchParams?.get('token');
  if (qp) return qp;

  return null;
}

/**
 * @returns {{ok: true} | {ok: false, status: number, error: string}}
 */
export function checkAuth(req, url) {
  const ip = ipOf(req);

  if (isLockedOut(ip)) {
    return { ok: false, status: 429, error: 'too many failed attempts' };
  }

  const presented = extractToken(req, url);
  if (!presented) {
    noteFailure(ip);
    return { ok: false, status: 401, error: 'missing token' };
  }

  if (!timingSafeEqual(presented, getToken())) {
    noteFailure(ip);
    return { ok: false, status: 403, error: 'invalid token' };
  }

  noteSuccess(ip);
  return { ok: true };
}
