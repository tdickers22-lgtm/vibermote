/**
 * Web Push: the VAPID keypair, the subscribed devices, and the rules about
 * what is worth waking a phone for.
 *
 * The problem this solves: the user starts a long agent run, puts the phone
 * down and walks away. Nothing else in this app can tell them it finished or
 * that it is sitting on a permission prompt waiting for a tap.
 *
 * ┌─ WHAT MAY GO IN A PAYLOAD ─────────────────────────────────────────────┐
 * │ A push notification renders on a LOCKED screen, and is decrypted by the │
 * │ phone's push daemon before the app ever sees it. Treat every field as   │
 * │ public: session name and status only.                                   │
 * │                                                                         │
 * │ Never: command text, transcript content, model output, the bearer token.│
 * │                                                                         │
 * │ Note the specific trap in titleFor() below — a `custom` session's        │
 * │ *label* is the first 32 characters of the command line the user typed    │
 * │ (see http-api.js), so the obvious "use session.label" would put command  │
 * │ text on the lock screen. Titles are built from the project directory     │
 * │ and the kind instead, never from the label.                             │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Storage mirrors saved-commands.js: one JSON file in the project root, 0600,
 * rewritten atomically. Both files here are secrets — the VAPID private key
 * authenticates this sender, and a subscription's keys are enough to push to
 * that device — so both are gitignored.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  PUSH_MAX_FAILURES,
  PUSH_RATE_MAX,
  PUSH_RATE_WINDOW_MS,
  PUSH_SESSION_COOLDOWN_MS,
  PUSH_SUBSCRIPTIONS_PATH,
  VAPID_PATH,
  VAPID_SUBJECT,
} from './config.js';
import { deliver, generateVapidKeys } from './web-push.js';
import { log, registerSecret } from './util.js';

/* ------------------------------------------------------------------ *
 * VAPID keypair
 * ------------------------------------------------------------------ */

let vapid = null;

/**
 * Load the keypair, generating it on first use. Written 0600 and its mode
 * re-asserted on every load, exactly as auth.js does for the token.
 *
 * Rotating this file invalidates every existing subscription (the browser bound
 * its subscription to the old public key), which is why it is generated once
 * and kept rather than derived per boot.
 */
export function loadOrCreateVapidKeys() {
  if (vapid) return vapid;

  let stored = null;
  if (fs.existsSync(VAPID_PATH)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(VAPID_PATH, 'utf8'));
      if (parsed?.publicKey && parsed?.privateKey) stored = parsed;
      else log.warn('VAPID key file is missing a key; regenerating');
    } catch (err) {
      log.warn(`VAPID key file unreadable (${err.message}); regenerating`);
    }
  }

  let created = false;
  if (!stored) {
    stored = { ...generateVapidKeys(), createdAt: Date.now() };
    fs.writeFileSync(VAPID_PATH, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    created = true;
  }

  try {
    fs.chmodSync(VAPID_PATH, 0o600);
  } catch (err) {
    log.warn(`could not enforce 0600 on ${VAPID_PATH}: ${err.message}`);
  }

  // Backstop against the private key ever reaching a log line, same as the token.
  registerSecret(stored.privateKey);

  vapid = { ...stored, subject: VAPID_SUBJECT };
  if (created) log.info(`generated a VAPID keypair at ${VAPID_PATH}`);
  return vapid;
}

/** The public half only. This is the one value that is safe to hand a browser. */
export function publicKey() {
  return loadOrCreateVapidKeys().publicKey;
}

/* ------------------------------------------------------------------ *
 * Subscriptions
 * ------------------------------------------------------------------ */

/** Enough for every device one person owns; a bound stops the file growing forever. */
const MAX_SUBSCRIPTIONS = 20;

/** id -> record */
let store = new Map();
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(PUSH_SUBSCRIPTIONS_PATH, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn(`push subscriptions unreadable: ${err.message}`);
    return;
  }
  const rows = Array.isArray(parsed?.subscriptions) ? parsed.subscriptions : [];
  for (const row of rows) {
    if (typeof row?.endpoint !== 'string' || !row?.keys?.p256dh || !row?.keys?.auth) continue;
    store.set(row.id || idFor(row.endpoint), {
      ...row,
      id: row.id || idFor(row.endpoint),
      failures: Number.isFinite(row.failures) ? row.failures : 0,
    });
  }
}

function persist() {
  const payload = `${JSON.stringify({ version: 1, subscriptions: [...store.values()] }, null, 2)}\n`;
  const tmp = `${PUSH_SUBSCRIPTIONS_PATH}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, payload, { mode: 0o600 });
    fs.renameSync(tmp, PUSH_SUBSCRIPTIONS_PATH);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* nothing to clean up */
    }
    throw new Error(`could not save push subscriptions: ${err.message}`);
  }
}

/** Stable id from the endpoint, so re-subscribing the same device updates its row. */
function idFor(endpoint) {
  return `push_${crypto.createHash('sha256').update(endpoint).digest('hex').slice(0, 12)}`;
}

/**
 * Endpoints must be https. The loopback exception is not a security boundary —
 * a caller holding the token can already run any command on this machine (see
 * the boundary note in http-api.js) — it exists so scripts/push-selftest.mjs
 * can drive a real subscribe → notify → deliver cycle against a local receiver
 * instead of against a mock.
 */
function validateEndpoint(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new ValidationError('endpoint is required');
  if (raw.length > 2048) throw new ValidationError('endpoint is implausibly long');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError('endpoint must be an absolute URL');
  }
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new ValidationError('endpoint must be an https URL');
  }
  return url.toString();
}

function validateKey(value, field, bytes) {
  if (typeof value !== 'string' || !value.trim()) throw new ValidationError(`keys.${field} is required`);
  const buf = Buffer.from(value, 'base64url');
  if (buf.length !== bytes) throw new ValidationError(`keys.${field} must decode to ${bytes} bytes`);
  return value.trim();
}

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.code = 'INVALID_INPUT';
  }
}

/** Add or refresh one device's subscription. Idempotent on the endpoint. */
export function subscribe(input = {}) {
  load();
  const endpoint = validateEndpoint(input.endpoint);
  const p256dh = validateKey(input.keys?.p256dh, 'p256dh', 65);
  const auth = validateKey(input.keys?.auth, 'auth', 16);

  const id = idFor(endpoint);
  const existing = store.get(id);
  if (!existing && store.size >= MAX_SUBSCRIPTIONS) {
    throw new ValidationError(`at most ${MAX_SUBSCRIPTIONS} subscribed devices`);
  }

  const now = Date.now();
  const record = {
    id,
    endpoint,
    keys: { p256dh, auth },
    label: typeof input.label === 'string' ? input.label.trim().slice(0, 60) : (existing?.label || ''),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    lastOkAt: existing?.lastOkAt || null,
    lastError: existing?.lastError || null,
    // A device that comes back after a failure run starts clean; the old count
    // described a subscription that has since been re-established.
    failures: 0,
  };
  store.set(id, record);
  persist();
  log.info(`push subscription ${existing ? 'refreshed' : 'added'}: ${id} (${new URL(endpoint).host})`);
  return publicView(record);
}

/** Remove by id or by endpoint. Returns the number of records dropped. */
export function unsubscribe({ id, endpoint } = {}) {
  load();
  const key = id || (typeof endpoint === 'string' && endpoint.trim() ? idFor(endpoint.trim()) : null);
  if (!key || !store.delete(key)) return 0;
  persist();
  log.info(`push subscription removed: ${key}`);
  return 1;
}

/**
 * What a client is allowed to see about a subscription.
 *
 * The endpoint path is a bearer credential for that device — anyone holding it
 * plus the keys can push to the phone — so the list reports the host and the
 * id, never the full URL and never the keys.
 */
function publicView(record) {
  let host = 'unknown';
  try {
    host = new URL(record.endpoint).host;
  } catch {
    /* keep the placeholder */
  }
  return {
    id: record.id,
    host,
    label: record.label || '',
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastOkAt: record.lastOkAt,
    lastError: record.lastError,
    failures: record.failures,
  };
}

export function listSubscriptions() {
  load();
  return [...store.values()].map(publicView);
}

export function subscriptionCount() {
  load();
  return store.size;
}

/* ------------------------------------------------------------------ *
 * Sending
 * ------------------------------------------------------------------ */

/** session id -> timestamp of the last notification, for the per-session cooldown. */
const lastNotifiedAt = new Map();
/** Timestamps inside the global rate window. */
let recentSends = [];

function rateLimited(sessionKey) {
  const now = Date.now();

  const last = lastNotifiedAt.get(sessionKey);
  if (last && now - last < PUSH_SESSION_COOLDOWN_MS) return 'session cooldown';

  recentSends = recentSends.filter((t) => now - t < PUSH_RATE_WINDOW_MS);
  if (recentSends.length >= PUSH_RATE_MAX) return 'global rate cap';

  return null;
}

function noteSent(sessionKey) {
  const now = Date.now();
  lastNotifiedAt.set(sessionKey, now);
  recentSends.push(now);
}

/**
 * Fan a payload out to every subscribed device.
 *
 * A 404/410 means the browser threw the subscription away (app deleted, or iOS
 * expired it), so the record is dropped rather than retried forever. Anything
 * else is counted, and a device that fails PUSH_MAX_FAILURES times in a row is
 * dropped too — an endpoint that has been unreachable that long is not coming
 * back, and retrying it delays every later notification.
 */
export async function sendToAll(payload, { topic } = {}) {
  load();
  if (!store.size) return { sent: 0, failed: 0, dropped: 0, results: [] };

  const vapidKeys = loadOrCreateVapidKeys();
  const text = JSON.stringify(payload);

  const results = await Promise.all([...store.values()].map(async (record) => {
    const outcome = await deliver({
      subscription: { endpoint: record.endpoint, keys: record.keys },
      payload: text,
      vapid: vapidKeys,
      topic,
    });
    return { record, outcome };
  }));

  let sent = 0;
  let failed = 0;
  let dropped = 0;
  const now = Date.now();

  for (const { record, outcome } of results) {
    if (outcome.ok) {
      sent += 1;
      record.lastOkAt = now;
      record.lastError = null;
      record.failures = 0;
      continue;
    }

    failed += 1;
    record.failures += 1;
    record.lastError = outcome.error;

    if (outcome.gone || record.failures >= PUSH_MAX_FAILURES) {
      store.delete(record.id);
      dropped += 1;
      log.info(`dropping dead push subscription ${record.id}: ${outcome.error}`);
    } else {
      log.warn(`push to ${record.id} failed: ${outcome.error}`);
    }
  }

  try {
    persist();
  } catch (err) {
    // Bookkeeping must never take down the caller — session-watch runs on a timer.
    log.warn(err.message);
  }

  return {
    sent,
    failed,
    dropped,
    results: results.map(({ record, outcome }) => ({
      id: record.id,
      ok: outcome.ok,
      status: outcome.status,
      error: outcome.error,
    })),
  };
}

/* ------------------------------------------------------------------ *
 * Session events
 * ------------------------------------------------------------------ */

/** Human wording per event. Deliberately terse — this is a lock-screen line. */
const EVENT_BODY = {
  exited: (detail) =>
    detail?.status != null && detail.status !== '0'
      ? `Finished with status ${detail.status}`
      : 'Finished',
  waiting: () => 'Waiting for your input',
  ended: () => 'Session ended',
};

/**
 * Build the notification title.
 *
 * Project directory plus tool, never `session.label`: for a `custom` session
 * the label is derived from the command line the user typed, and that must not
 * reach a lock screen. See the payload rules at the top of this file.
 */
function titleFor({ projectName, kindLabel }) {
  const project = (projectName || 'session').slice(0, 40);
  return kindLabel ? `${project} · ${kindLabel}` : project;
}

/**
 * Called by session-watch when a session changes state in a way worth a phone
 * buzzing. Returns what it did, so the self-test and the logs can see the
 * suppression reasons rather than a silent no-op.
 *
 * @param {object} event
 * @param {'exited'|'waiting'|'ended'} event.type
 * @param {string} event.sessionId    `live:<tmux-name>`, carried so a tap deep-links
 * @param {string} event.projectName  directory basename — the session's public name
 * @param {string} event.kindLabel    e.g. "Claude Code"
 * @param {object} [event.detail]     `{status}` for an exit
 */
export async function notifySessionEvent(event) {
  load();
  if (!store.size) return { skipped: 'no subscriptions' };

  const limited = rateLimited(event.sessionId);
  if (limited) {
    log.debug(`push suppressed for ${event.sessionId}: ${limited}`);
    return { skipped: limited };
  }

  const body = (EVENT_BODY[event.type] || (() => 'Updated'))(event.detail);
  const payload = {
    title: titleFor(event),
    body,
    event: event.type,
    sessionId: event.sessionId,
    // Same tag per session: a newer notification replaces the older one on the
    // phone instead of stacking three cards for the same terminal.
    tag: event.sessionId,
    at: Date.now(),
  };

  noteSent(event.sessionId);
  const result = await sendToAll(payload, { topic: topicFor(event.sessionId) });
  log.info(`push "${payload.title} — ${body}" -> ${result.sent} ok, ${result.failed} failed`);
  return result;
}

/**
 * Push topics must be short and URL-safe base64, so the tmux name is hashed
 * rather than sent. Same session -> same topic -> the service collapses
 * undelivered duplicates.
 */
function topicFor(sessionId) {
  return crypto.createHash('sha256').update(sessionId).digest('base64url').slice(0, 22);
}

/** Forget a session's cooldown state — used when the user kills it deliberately. */
export function forgetSessionState(sessionId) {
  lastNotifiedAt.delete(sessionId);
}

/* ------------------------------------------------------------------ *
 * HTTP API
 * ------------------------------------------------------------------ */

/**
 * The `/api/push/` subtree, dispatched from http-api.js.
 *
 * AUTH: every route here is reached only from inside the authenticated block in
 * createHttpHandler(), the same gate as /api/sessions. Nothing in this file may
 * ever be called before checkAuth() — a subscription endpoint is a way to make
 * this machine issue authenticated requests to a third party, and the routes
 * also disclose which devices are subscribed.
 *
 * Returns false when the path is not ours, so http-api.js falls through to 404.
 */
export async function handlePushApi({ req, res, pathname, method, readBody, sendJson }) {
  if (pathname !== '/api/push' && !pathname.startsWith('/api/push/')) return false;

  /* -------- the public key a browser needs to subscribe -------- */
  if ((pathname === '/api/push/key' || pathname === '/api/push') && method === 'GET') {
    sendJson(res, 200, { publicKey: publicKey(), subject: VAPID_SUBJECT });
    return true;
  }

  /* -------- which devices are subscribed -------- */
  if ((pathname === '/api/push/subscriptions' || pathname === '/api/push/status') && method === 'GET') {
    const subscriptions = listSubscriptions();
    sendJson(res, 200, {
      publicKey: publicKey(),
      subject: VAPID_SUBJECT,
      enabled: subscriptions.length > 0,
      count: subscriptions.length,
      subscriptions,
    });
    return true;
  }

  if (pathname === '/api/push/subscribe' && method === 'POST') {
    const body = (await readBody(req)) || {};
    try {
      sendJson(res, 201, { ok: true, subscription: subscribe(body) });
    } catch (err) {
      if (err instanceof ValidationError) sendJson(res, 400, { error: err.message });
      else throw err;
    }
    return true;
  }

  if (pathname === '/api/push/unsubscribe' && method === 'POST') {
    const body = (await readBody(req)) || {};
    const removed = unsubscribe(body);
    sendJson(res, 200, { ok: true, removed });
    return true;
  }

  /* -------- send a real notification, so delivery can be proven -------- */
  if (pathname === '/api/push/test' && method === 'POST') {
    if (!subscriptionCount()) {
      sendJson(res, 409, { error: 'no device is subscribed yet' });
      return true;
    }
    const result = await sendToAll({
      title: 'Vibermote',
      body: 'Notifications are working',
      event: 'test',
      sessionId: null,
      tag: 'vibermote-test',
      at: Date.now(),
    }, { topic: 'vibermote-test' });
    sendJson(res, 200, { ok: result.sent > 0, ...result });
    return true;
  }

  sendJson(res, 404, { error: 'no such endpoint' });
  return true;
}
