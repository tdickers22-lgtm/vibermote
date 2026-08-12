/**
 * The user's own saved commands.
 *
 * This is what makes the phone feel like *their* machine rather than a generic
 * terminal: `npm run dev`, `pytest -x`, `git status`, `tail -f train.log`. Each
 * one is a name, a command line, and optionally a directory to run it in. The
 * client renders them as one-tap tiles; launching one creates an ordinary
 * `custom` session through exactly the same path as `claude` or `codex`.
 *
 * Storage is a single JSON file in the project root, written 0600 and rewritten
 * atomically (temp file + rename) so a crash mid-write can never leave the user
 * with a truncated file and an empty command list.
 *
 * SECURITY: every string stored here is a command line this server will
 * execute. That is the product, not a bug — see the boundary note in
 * http-api.js. Nothing in this module sanitises shell syntax, because shell
 * syntax is the feature; the bearer token is what stops a stranger writing
 * here.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SAVED_COMMANDS_PATH } from './config.js';
import { log } from './util.js';

export const LIMITS = {
  name: 80,
  command: 4096,
  cwd: 1024,
  icon: 8,
  /** Enough for any realistic set of tiles; a bound stops the file growing without end. */
  count: 200,
};

/** id -> record. Insertion order is the user's chosen order. */
let store = new Map();
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  let raw;
  try {
    raw = fs.readFileSync(SAVED_COMMANDS_PATH, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn(`saved commands unreadable: ${err.message}`);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Keep the damaged file rather than silently overwriting the user's list;
    // they may want to hand-repair it.
    log.warn(`saved commands file is not valid JSON (${err.message}) — starting empty`);
    return;
  }

  const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.commands) ? parsed.commands : [];
  for (const row of rows) {
    const rec = coerce(row);
    if (rec) store.set(rec.id, rec);
  }
}

/** Accept a row from disk, dropping anything malformed rather than throwing. */
function coerce(row) {
  if (!row || typeof row !== 'object') return null;
  const id = typeof row.id === 'string' && ID_RE.test(row.id) ? row.id : newId();
  const name = typeof row.name === 'string' ? row.name.trim() : '';
  const command = typeof row.command === 'string' ? row.command.trim() : '';
  if (!name || !command) return null;
  return {
    id,
    name: name.slice(0, LIMITS.name),
    command: command.slice(0, LIMITS.command),
    cwd: typeof row.cwd === 'string' && row.cwd.trim() ? row.cwd.trim().slice(0, LIMITS.cwd) : null,
    icon: typeof row.icon === 'string' && row.icon.trim() ? row.icon.trim().slice(0, LIMITS.icon) : null,
    color: typeof row.color === 'string' && COLOR_RE.test(row.color) ? row.color : null,
    createdAt: Number.isFinite(row.createdAt) ? row.createdAt : Date.now(),
    updatedAt: Number.isFinite(row.updatedAt) ? row.updatedAt : Date.now(),
    lastRunAt: Number.isFinite(row.lastRunAt) ? row.lastRunAt : null,
    runCount: Number.isFinite(row.runCount) && row.runCount >= 0 ? Math.floor(row.runCount) : 0,
  };
}

const ID_RE = /^cmd_[0-9a-f]{12}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function newId() {
  return `cmd_${crypto.randomBytes(6).toString('hex')}`;
}

/**
 * Write the whole file atomically.
 *
 * rename(2) within a directory is atomic, so a reader (or a crash) sees either
 * the complete old file or the complete new one, never a half-written list.
 */
function persist() {
  const payload = `${JSON.stringify({ version: 1, commands: [...store.values()] }, null, 2)}\n`;
  const tmp = `${SAVED_COMMANDS_PATH}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, payload, { mode: 0o600 });
    fs.renameSync(tmp, SAVED_COMMANDS_PATH);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* nothing to clean up */
    }
    throw new Error(`could not save commands: ${err.message}`);
  }
}

/** Thrown for anything the caller can fix; the HTTP layer turns it into a 400. */
class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.code = 'INVALID_INPUT';
  }
}

function requireString(value, field, max) {
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new ValidationError(`${field} must not be empty`);
  if (trimmed.length > max) throw new ValidationError(`${field} must be at most ${max} characters`);
  if (trimmed.includes('\0')) throw new ValidationError(`${field} must not contain a null byte`);
  return trimmed;
}

/** Optional free-text field: null clears it, undefined leaves it alone. */
function optionalString(value, field, max) {
  if (value == null) return null;
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string or null`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) throw new ValidationError(`${field} must be at most ${max} characters`);
  if (trimmed.includes('\0')) throw new ValidationError(`${field} must not contain a null byte`);
  return trimmed;
}

function optionalColor(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || !COLOR_RE.test(value)) {
    throw new ValidationError('color must be a #rrggbb hex string or null');
  }
  return value;
}

export function listCommands() {
  load();
  return [...store.values()];
}

export function getCommand(id) {
  load();
  if (typeof id !== 'string') return null;
  return store.get(id) || null;
}

export function createCommand(input = {}) {
  load();
  if (store.size >= LIMITS.count) {
    throw new ValidationError(`at most ${LIMITS.count} saved commands`);
  }
  const now = Date.now();
  const rec = {
    id: newId(),
    name: requireString(input.name, 'name', LIMITS.name),
    // Note the deliberate absence of any shell-metacharacter filter.
    command: requireString(input.command, 'command', LIMITS.command),
    cwd: optionalString(input.cwd ?? input.projectDir, 'cwd', LIMITS.cwd),
    icon: optionalString(input.icon, 'icon', LIMITS.icon),
    color: optionalColor(input.color),
    createdAt: now,
    updatedAt: now,
    lastRunAt: null,
    runCount: 0,
  };
  store.set(rec.id, rec);
  persist();
  log.info(`saved command created: ${rec.id} (${rec.name})`);
  return rec;
}

/** Partial update. Fields absent from `patch` keep their current value. */
export function updateCommand(id, patch = {}) {
  load();
  const existing = store.get(id);
  if (!existing) return null;

  const next = { ...existing };
  if ('name' in patch) next.name = requireString(patch.name, 'name', LIMITS.name);
  if ('command' in patch) next.command = requireString(patch.command, 'command', LIMITS.command);
  if ('cwd' in patch || 'projectDir' in patch) {
    next.cwd = optionalString(patch.cwd ?? patch.projectDir, 'cwd', LIMITS.cwd);
  }
  if ('icon' in patch) next.icon = optionalString(patch.icon, 'icon', LIMITS.icon);
  if ('color' in patch) next.color = optionalColor(patch.color);
  next.updatedAt = Date.now();

  store.set(id, next);
  persist();
  return next;
}

export function deleteCommand(id) {
  load();
  if (!store.delete(id)) return false;
  persist();
  log.info(`saved command deleted: ${id}`);
  return true;
}

/**
 * Record that a command was launched.
 *
 * Best-effort by design: failing to write a usage counter must never abort a
 * session the user is waiting on, so a persist failure is logged and swallowed.
 */
export function noteRun(id) {
  load();
  const rec = store.get(id);
  if (!rec) return null;
  rec.lastRunAt = Date.now();
  rec.runCount += 1;
  try {
    persist();
  } catch (err) {
    log.warn(err.message);
  }
  return rec;
}

export { ValidationError };
