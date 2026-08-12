/**
 * Discovery of *dormant* (resumable) Claude Code sessions from
 * ~/.claude/projects/<project>/*.jsonl.
 *
 * STRICTLY READ-ONLY. These are the user's real session transcripts; this
 * module opens files with flag 'r' and never writes, renames, or deletes.
 *
 * Two facts about the corpus on this machine shape the whole design:
 *
 *   - There are ~2.3k .jsonl files totalling ~2GB, with single transcripts up
 *     to 58MB. Reading them whole would be unusable, so we read only the tail
 *     of each file.
 *   - Only files that are *direct* children of a project directory are real,
 *     resumable sessions (~320 of them). The other ~2000 live in nested
 *     subdirectories (subagents/, workflows/) and are agent logs that
 *     `claude --resume` cannot open, so they are excluded.
 *
 * Results are cached per file and invalidated by (size, mtime).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { CLAUDE_PROJECTS_DIR } from './config.js';
import { log, summarize } from './util.js';

/** Bytes read from the end of each transcript. */
const TAIL_BYTES = 256 * 1024;

/** file path -> { size, mtimeMs, entry } */
const cache = new Map();

/**
 * Claude encodes a project directory as its absolute path with separators
 * replaced by '-'. That is lossy (a real '-' in a path is indistinguishable
 * from a separator), so this is only a fallback: the authoritative cwd comes
 * from the `cwd` field inside the transcript, which 317/320 files carry.
 */
export function decodeProjectDirName(name) {
  if (!name.startsWith('-')) return name;
  return `/${name.slice(1).replace(/-/g, '/')}`;
}

/** Noise that must never surface as a session preview. */
function isNoisePrompt(text) {
  if (!text) return true;
  const t = text.trim();
  if (!t) return true;
  return (
    t.startsWith('<command-name>') ||
    t.startsWith('<local-command-stdout>') ||
    t.startsWith('<command-message>') ||
    t.startsWith('Caveat: The messages below') ||
    t.startsWith('<system-reminder>') ||
    t.startsWith('[Request interrupted')
  );
}

/** Pull plain text out of a user message, ignoring tool results and images. */
function userText(message) {
  if (!message || typeof message !== 'object') return null;
  const content = message.content;

  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      // tool_result blocks are by far the most common user record and are
      // never something a human typed — showing them would fill the session
      // list with command output.
      if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
    return parts.join(' ').trim() || null;
  }

  return null;
}

/** Read the last TAIL_BYTES of a file, discarding a leading partial line. */
async function readTail(filePath, size) {
  const fh = await fs.open(filePath, 'r'); // 'r' — read-only, never creates
  try {
    const start = size > TAIL_BYTES ? size - TAIL_BYTES : 0;
    const length = size - start;
    if (length <= 0) return '';
    const buf = Buffer.allocUnsafe(length);
    await fh.read(buf, 0, length, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    return text;
  } finally {
    await fh.close();
  }
}

/**
 * Parse one transcript's tail into a listing entry, or null if it is not a
 * real session (e.g. a 146-byte `bridge-session` stub with no conversation).
 */
async function parseTranscript(filePath, projectDirName, stat) {
  let text;
  try {
    text = await readTail(filePath, stat.size);
  } catch (err) {
    log.debug(`unreadable transcript ${filePath}: ${err.message}`);
    return null;
  }

  let aiTitle = null;
  let lastPrompt = null;
  let cwd = null;
  let gitBranch = null;
  let sessionId = null;
  let lastTimestamp = null;
  let sawConversation = false;
  const userTexts = [];

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // truncated or interleaved write — skip the line, not the file
    }

    const type = rec.type;

    // Claude maintains these as rolling summaries; the last one wins.
    if (type === 'ai-title' && rec.aiTitle) aiTitle = rec.aiTitle;
    if (type === 'last-prompt' && rec.lastPrompt) lastPrompt = rec.lastPrompt;

    if (rec.cwd) cwd = rec.cwd;
    if (rec.gitBranch) gitBranch = rec.gitBranch;
    if (rec.sessionId) sessionId = rec.sessionId;
    if (rec.timestamp) lastTimestamp = rec.timestamp;

    if (type === 'user' || type === 'assistant') {
      sawConversation = true;
      // Sidechain records belong to subagents, not the main thread.
      if (type === 'user' && !rec.isSidechain) {
        const t = userText(rec.message);
        if (t && !isNoisePrompt(t)) userTexts.push(t);
      }
    }
  }

  // A file whose tail holds only bookkeeping records is not resumable content.
  // (Very small stub files contain nothing but a `bridge-session` line.)
  if (!sawConversation && !aiTitle && !lastPrompt) return null;

  const sessionIdFromName = path.basename(filePath, '.jsonl');
  const preview = lastPrompt || userTexts[userTexts.length - 1] || '';

  const projectDir = cwd || decodeProjectDirName(projectDirName);
  const label = aiTitle || summarize(preview, 60) || path.basename(projectDir);

  return {
    sessionId: sessionId || sessionIdFromName,
    file: filePath,
    projectDir,
    projectDirName,
    gitBranch: gitBranch || null,
    title: aiTitle || null,
    label,
    preview: summarize(preview, 160),
    lastActivity: lastTimestamp ? Date.parse(lastTimestamp) || stat.mtimeMs : stat.mtimeMs,
    mtimeMs: stat.mtimeMs,
    sizeBytes: stat.size,
  };
}

/**
 * List every resumable session. Cheap on repeat calls: unchanged files are
 * served from cache, so only transcripts that actually moved get re-parsed.
 */
export async function listDormantSessions() {
  let projectDirs;
  try {
    projectDirs = await fs.readdir(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
  } catch (err) {
    log.warn(`cannot read ${CLAUDE_PROJECTS_DIR}: ${err.message}`);
    return [];
  }

  const jobs = [];
  const seenPaths = new Set();

  for (const dirent of projectDirs) {
    if (!dirent.isDirectory()) continue;
    const projectDirName = dirent.name;
    const dirPath = path.join(CLAUDE_PROJECTS_DIR, projectDirName);

    let files;
    try {
      files = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const f of files) {
      // Direct children only — nested dirs hold subagent/workflow logs.
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const filePath = path.join(dirPath, f.name);
      seenPaths.add(filePath);

      jobs.push(
        (async () => {
          let stat;
          try {
            stat = await fs.stat(filePath);
          } catch {
            return null;
          }

          const hit = cache.get(filePath);
          if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) {
            return hit.entry;
          }

          const entry = await parseTranscript(filePath, projectDirName, stat);
          cache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, entry });
          return entry;
        })(),
      );
    }
  }

  const settled = await Promise.all(jobs);

  // Drop cache entries for transcripts that no longer exist.
  for (const key of cache.keys()) {
    if (!seenPaths.has(key)) cache.delete(key);
  }

  return settled.filter(Boolean).sort((a, b) => b.lastActivity - a.lastActivity);
}

/*
 * The project-directory picker now spans every kind, so it lives in
 * discovery.js (`listProjects`) rather than here.
 */

export function clearTranscriptCache() {
  cache.clear();
}
