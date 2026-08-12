/**
 * Small shared helpers: logging that can never leak the token, shell quoting,
 * and constant-time string comparison.
 */
import crypto from 'node:crypto';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const LEVEL = LEVELS[process.env.CCR_LOG_LEVEL] ?? LEVELS.info;

/** Values registered here are redacted from every log line. */
const secrets = new Set();

export function registerSecret(value) {
  if (value && value.length >= 8) secrets.add(value);
}

function redact(text) {
  let out = text;
  for (const s of secrets) {
    if (out.includes(s)) out = out.split(s).join('[REDACTED]');
  }
  return out;
}

function emit(level, ...args) {
  if (LEVELS[level] > LEVEL) return;
  const line = args
    .map((a) => (typeof a === 'string' ? a : safeInspect(a)))
    .join(' ');
  const stamp = new Date().toISOString();
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`${stamp} ${level.toUpperCase().padEnd(5)} ${redact(line)}\n`);
}

function safeInspect(value) {
  if (value instanceof Error) return value.stack || value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const log = {
  error: (...a) => emit('error', ...a),
  warn: (...a) => emit('warn', ...a),
  info: (...a) => emit('info', ...a),
  debug: (...a) => emit('debug', ...a),
};

/** Compare two strings without leaking length or content through timing. */
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  // Hash first so differing lengths cannot short-circuit the comparison.
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Quote a string for safe interpolation into a POSIX shell command. */
export function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Collapse whitespace and hard-truncate, for building list previews. */
export function summarize(text, max = 160) {
  if (typeof text !== 'string') return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
