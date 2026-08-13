/**
 * opencode token usage.
 *
 * Claude and Codex write JSONL transcripts, so usage.js parses files. opencode
 * keeps a SQLite database instead, and — unlike the other two — has already
 * done the accounting: its `session` table carries per-session token counts and
 * a computed cost, so nothing here needs to price anything itself.
 *
 * Read through /usr/bin/sqlite3 rather than a driver: Node 20 has no
 * `node:sqlite` (that lands in 22) and a native module would have to be rebuilt
 * for every Node the user switches to with nvm. The binary is at a fixed system
 * path that needs no PATH to find it, which matters because this runs under
 * launchd. The database is opened read-only and immutable, so a running
 * opencode cannot be disturbed and a stale lock cannot block the read.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { log } from './util.js';

const SQLITE = '/usr/bin/sqlite3';
export const OPENCODE_DB = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');

export function opencodeAvailable() {
  try {
    return fs.existsSync(OPENCODE_DB) && fs.existsSync(SQLITE);
  } catch {
    return false;
  }
}

function query(sql) {
  return new Promise((resolve) => {
    // file: URI with immutable=1 — never take a lock, never write, and read
    // happily while opencode itself has the database open.
    const uri = `file:${OPENCODE_DB}?immutable=1`;
    execFile(SQLITE, ['-readonly', '-json', uri, sql], { timeout: 8000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          log.debug(`opencode usage query failed: ${err.message}`);
          return resolve([]);
        }
        const text = String(stdout).trim();
        if (!text) return resolve([]);
        try { resolve(JSON.parse(text)); }
        catch (e) {
          log.debug(`opencode usage returned non-JSON: ${e.message}`);
          resolve([]);
        }
      });
  });
}

/**
 * opencode stores the model as a JSON blob, e.g.
 * `{"id":"kimi-k3","providerID":"veniceai","variant":"default"}`.
 * Only the readable name is wanted.
 */
function modelName(raw) {
  if (!raw) return 'unknown';
  try {
    const m = JSON.parse(raw);
    return m.id || m.modelID || 'unknown';
  } catch {
    return String(raw);
  }
}

function providerName(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw).providerID || null; } catch { return null; }
}

const CACHE_MS = 30_000;
let cache = { at: 0, rows: null };

async function sessions() {
  if (cache.rows && Date.now() - cache.at < CACHE_MS) return cache.rows;
  const rows = await query(`
    SELECT id, title, directory, model, agent, cost,
           tokens_input, tokens_output, tokens_reasoning,
           tokens_cache_read, tokens_cache_write,
           time_created, time_updated
    FROM session
    WHERE tokens_input > 0 OR tokens_output > 0
    ORDER BY time_updated DESC
  `.replace(/\s+/g, ' ').trim());

  const mapped = rows.map((r) => ({
    id: r.id,
    title: r.title || 'opencode session',
    projectDir: r.directory || null,
    model: modelName(r.model),
    provider: providerName(r.model),
    agent: r.agent || null,
    cost: Number(r.cost) || 0,
    input: Number(r.tokens_input) || 0,
    output: Number(r.tokens_output) || 0,
    reasoning: Number(r.tokens_reasoning) || 0,
    cacheRead: Number(r.tokens_cache_read) || 0,
    cacheWrite: Number(r.tokens_cache_write) || 0,
    // opencode stores milliseconds.
    startedAt: Number(r.time_created) || 0,
    updatedAt: Number(r.time_updated) || Number(r.time_created) || 0,
  }));
  cache = { at: Date.now(), rows: mapped };
  return mapped;
}

function withinWindow(row, sinceMs) {
  return !sinceMs || row.updatedAt >= sinceMs;
}

/** Totals for a time window, shaped like the other sources' summaries. */
export async function opencodeUsage({ sinceMs = 0 } = {}) {
  if (!opencodeAvailable()) {
    return { available: false, sessions: [], totals: null, byModel: [] };
  }
  const rows = (await sessions()).filter((r) => withinWindow(r, sinceMs));

  const totals = rows.reduce((acc, r) => {
    acc.input += r.input;
    acc.output += r.output;
    acc.reasoning += r.reasoning;
    acc.cacheRead += r.cacheRead;
    acc.cacheWrite += r.cacheWrite;
    acc.cost += r.cost;
    return acc;
  }, { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, sessions: rows.length });

  const models = new Map();
  for (const r of rows) {
    const key = r.model;
    const m = models.get(key) || {
      model: key, provider: r.provider, sessions: 0,
      input: 0, output: 0, cacheRead: 0, cost: 0,
    };
    m.sessions += 1;
    m.input += r.input;
    m.output += r.output;
    m.cacheRead += r.cacheRead;
    m.cost += r.cost;
    models.set(key, m);
  }

  return {
    available: true,
    totals,
    byModel: [...models.values()].sort((a, b) => (b.input + b.output) - (a.input + a.output)),
    sessions: rows,
  };
}
