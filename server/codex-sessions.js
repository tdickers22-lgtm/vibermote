/**
 * Discovery of *dormant* (resumable) Codex sessions from
 * ~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<iso>-<uuid>.jsonl.
 *
 * STRICTLY READ-ONLY. These are the user's real session rollouts; this module
 * opens files with flag 'r' and never writes, renames, or deletes.
 *
 * WHY JSONL AND NOT THE SQLITE INDEX
 * ~/.codex/state_5.sqlite has a `threads` table that is a perfect index of
 * exactly these sessions (id, cwd, title, preview, git_branch, archived,
 * recency_at_ms — 145 rows for 145 rollout files). Reading it would be
 * strictly better, but this server runs on Node 20, where `node:sqlite` does
 * not exist, and the DB is open with a live WAL that a reader must not
 * disturb. Pulling in better-sqlite3 (a native build) to read one table is
 * not worth it, so the rollout files are parsed instead. The one thing lost is
 * the `archived` flag: a session the user archived still appears here.
 *
 * Two facts about the corpus on this machine shape the design:
 *
 *   - 145 rollouts totalling ~2.1GB, individual files up to 118MB. Reading
 *     them whole is impossible, so only the head and tail of each file is read.
 *   - Only 28 are real top-level sessions. The other 117 carry
 *     `thread_source: "subagent"` and are spawned agent threads that the user
 *     never drove directly, so they are excluded — the same distinction
 *     transcripts.js draws between project-level and nested Claude logs.
 *
 * Results are cached per file and invalidated by (size, mtime).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { CODEX_SESSIONS_DIR } from './config.js';
import { log, summarize } from './util.js';

/**
 * Bytes read from the start of each rollout.
 *
 * The `session_meta` record is line 1 and runs ~19KB (it embeds the full Codex
 * base instructions). The first user message then lands within ~60KB. 192KB
 * clears both with room to spare.
 */
const HEAD_BYTES = 192 * 1024;

/** Bytes read from the end, for the most recent prompt. */
const TAIL_BYTES = 128 * 1024;

/** file path -> { size, mtimeMs, entry } */
const cache = new Map();

/** rollout-2026-08-10T19-48-36-019fed38-49c4-7323-9c83-47bb17833903.jsonl */
const ROLLOUT_RE = /^rollout-.*?-([0-9a-fA-F-]{36})\.jsonl$/;

/**
 * Is this rollout a session the user drove directly, rather than an agent
 * thread some other session spawned?
 *
 * Two generations of the format have to be handled. Recent rollouts carry
 * `thread_source: "user" | "subagent"` and are unambiguous. The 47 older ones
 * on this machine (codex 0.101–0.125, Feb–May) have no such field, and there
 * the discriminator is `source`: a plain string ("cli") is a real session,
 * while an object is a spawn record like
 * `{subagent:{thread_spawn:{parent_thread_id, depth, …}}}`. Checking only
 * `thread_source` would let two old subagent threads through.
 */
function isTopLevel(meta) {
  if (typeof meta.thread_source === 'string') return meta.thread_source === 'user';
  return typeof meta.source !== 'object' || meta.source === null;
}

/** Codex session ids are UUIDs; anything else must never reach a command line. */
export function isCodexSessionId(value) {
  return typeof value === 'string' && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value);
}

/** Wrapper blocks Codex injects into the transcript that no human typed. */
function isNoiseMessage(text) {
  if (!text) return true;
  const t = text.trim();
  if (!t) return true;
  return (
    t.startsWith('<environment_context>') ||
    t.startsWith('<user_instructions>') ||
    t.startsWith('<permissions instructions>') ||
    t.startsWith('<collaboration_mode>') ||
    t.startsWith('<skills_instructions>') ||
    t.startsWith('## My request for Codex')
  );
}

/** Read `length` bytes at `start`, read-only, never creating the file. */
async function readChunk(filePath, start, length) {
  if (length <= 0) return '';
  const fh = await fs.open(filePath, 'r'); // 'r' — read-only
  try {
    const buf = Buffer.allocUnsafe(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return buf.toString('utf8', 0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** Head of the file, dropping any trailing partial line. */
async function readHead(filePath, size) {
  const text = await readChunk(filePath, 0, Math.min(size, HEAD_BYTES));
  if (size <= HEAD_BYTES) return text;
  const nl = text.lastIndexOf('\n');
  return nl >= 0 ? text.slice(0, nl) : '';
}

/** Tail of the file, dropping a leading partial line. */
async function readTail(filePath, size) {
  if (size <= HEAD_BYTES) return ''; // head already covered the whole file
  const start = Math.max(0, size - TAIL_BYTES);
  const text = await readChunk(filePath, start, size - start);
  const nl = text.indexOf('\n');
  return nl >= 0 ? text.slice(nl + 1) : '';
}

/** Pull the plain text out of a Codex `user_message` event payload. */
function messageText(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const msg = payload.message;
  if (typeof msg === 'string') return msg;
  if (Array.isArray(msg)) {
    return msg.map((m) => (typeof m === 'string' ? m : m?.text || '')).join(' ').trim() || null;
  }
  return null;
}

/** Scan JSONL text for user/agent messages, newest last. */
function scanMessages(text) {
  const users = [];
  let firstAgent = null;
  let lastTimestamp = null;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    // Cheap reject before the expensive parse: most lines are token counts and
    // response items, and these files run to hundreds of thousands of lines.
    const interesting = line.includes('_message');
    if (!interesting && !line.includes('"timestamp"')) continue;

    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // truncated or interleaved write — skip the line, not the file
    }
    if (rec.timestamp) lastTimestamp = rec.timestamp;
    if (rec.type !== 'event_msg') continue;

    const p = rec.payload;
    if (p?.type === 'user_message') {
      const t = messageText(p);
      if (t && !isNoiseMessage(t)) users.push(t);
    } else if (p?.type === 'agent_message' && firstAgent == null) {
      const t = messageText(p);
      if (t) firstAgent = t;
    }
  }

  return { users, firstAgent, lastTimestamp };
}

/**
 * Parse one rollout into a listing entry, or null when it is not a top-level
 * resumable session.
 */
async function parseRollout(filePath, stat) {
  let head;
  try {
    head = await readHead(filePath, stat.size);
  } catch (err) {
    log.debug(`unreadable rollout ${filePath}: ${err.message}`);
    return null;
  }

  const firstNl = head.indexOf('\n');
  const firstLine = firstNl >= 0 ? head.slice(0, firstNl) : head;

  let meta;
  try {
    const rec = JSON.parse(firstLine);
    if (rec.type !== 'session_meta') return null;
    meta = rec.payload || {};
  } catch {
    return null; // no parseable session_meta — not a rollout we understand
  }

  // Subagent threads are spawned by another session and are not terminals the
  // user ever drove. 72 of 145 files on this machine are these.
  if (!isTopLevel(meta)) return null;

  const sessionId = meta.session_id || meta.id || (ROLLOUT_RE.exec(path.basename(filePath))?.[1] ?? null);
  if (!isCodexSessionId(sessionId)) return null;

  const headScan = scanMessages(head);

  let tailScan = { users: [], firstAgent: null, lastTimestamp: null };
  try {
    const tail = await readTail(filePath, stat.size);
    if (tail) tailScan = scanMessages(tail);
  } catch (err) {
    log.debug(`tail unreadable for ${filePath}: ${err.message}`);
  }

  // First prompt reads like a title; the most recent one is the useful preview.
  const firstPrompt = headScan.users[0] || null;
  const lastPrompt =
    tailScan.users[tailScan.users.length - 1] || headScan.users[headScan.users.length - 1] || null;

  const projectDir = meta.cwd || null;
  const label =
    summarize(firstPrompt, 60) ||
    summarize(headScan.firstAgent, 60) ||
    (projectDir ? path.basename(projectDir) : sessionId.slice(0, 8));

  const startedAt = meta.timestamp ? Date.parse(meta.timestamp) || null : null;
  const lastTs = tailScan.lastTimestamp || headScan.lastTimestamp;
  const lastActivity = (lastTs ? Date.parse(lastTs) : null) || stat.mtimeMs;

  return {
    sessionId,
    file: filePath,
    projectDir,
    gitBranch: null, // rollouts carry no git metadata; only the sqlite index does
    title: firstPrompt ? summarize(firstPrompt, 60) : null,
    label,
    preview: summarize(lastPrompt || headScan.firstAgent || '', 160),
    lastActivity,
    startedAt,
    mtimeMs: stat.mtimeMs,
    sizeBytes: stat.size,
    cliVersion: meta.cli_version || null,
    model: meta.model_provider || null,
  };
}

/** Every rollout file under sessions/<yyyy>/<mm>/<dd>/. */
async function listRolloutFiles(dir, depth, out) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    // Layout is year/month/day; stop descending past that so a stray deep tree
    // cannot turn discovery into an unbounded walk.
    if (e.isDirectory() && depth < 3) await listRolloutFiles(full, depth + 1, out);
    else if (e.isFile() && ROLLOUT_RE.test(e.name)) out.push(full);
  }
  return out;
}

/**
 * List every resumable Codex session. Cheap on repeat calls: unchanged files
 * are served from cache, so only rollouts that actually moved get re-parsed.
 */
export async function listDormantCodexSessions() {
  let files;
  try {
    files = await listRolloutFiles(CODEX_SESSIONS_DIR, 0, []);
  } catch (err) {
    log.warn(`cannot read ${CODEX_SESSIONS_DIR}: ${err.message}`);
    return [];
  }

  const seen = new Set(files);

  const settled = await Promise.all(
    files.map(async (filePath) => {
      let stat;
      try {
        stat = await fs.stat(filePath);
      } catch {
        return null;
      }

      const hit = cache.get(filePath);
      if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) return hit.entry;

      const entry = await parseRollout(filePath, stat);
      cache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, entry });
      return entry;
    }),
  );

  for (const key of cache.keys()) {
    if (!seen.has(key)) cache.delete(key);
  }

  return settled.filter(Boolean).sort((a, b) => b.lastActivity - a.lastActivity);
}

export function clearCodexCache() {
  cache.clear();
}
