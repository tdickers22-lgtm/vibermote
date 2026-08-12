/**
 * Token-usage and cost accounting.
 *
 * STRICTLY READ-ONLY over ~/.claude/projects and ~/.codex/sessions. Every file
 * here is opened for reading only; nothing is written, renamed or deleted under
 * either tree. The only files this module writes are inside PROJECT_ROOT: the
 * parse cache and (if absent) the editable price table.
 *
 *
 * WHERE THE NUMBERS COME FROM
 *
 * Claude: every `assistant` record in a transcript carries `message.usage` with
 * `input_tokens`, `output_tokens`, `cache_read_input_tokens`,
 * `cache_creation_input_tokens` and — on recent versions — a `cache_creation`
 * split into `ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`. Those
 * four buckets are priced very differently (cache reads are ~10x cheaper than
 * input and, on this machine, outnumber it by ~1000x), so they are kept apart
 * everywhere in this file and never summed into a single "tokens" number. Cost
 * is the only scalar that can honestly be compared, and it is an estimate.
 *
 * Codex: contrary to the sqlite index (~/.codex/logs_2.sqlite has no usage
 * columns) and history.jsonl (session_id/text/ts only), the *rollout* JSONL does
 * carry accounting: `event_msg` records of type `token_count` hold
 * `info.total_token_usage` = {input_tokens, cached_input_tokens, output_tokens,
 * reasoning_output_tokens, total_tokens}, cumulative and monotonic over the
 * session, so the last such record is the session total. Verified monotonic on
 * the largest rollouts on this machine (6,722 events across 382MB). Codex does
 * NOT break cache writes out, and no list price is shipped for its models, so
 * cost comes back null with a reason rather than a zero that reads as "free".
 *
 *
 * TWO CORRECTNESS TRAPS THIS MODULE HANDLES
 *
 * 1. Duplicate usage records. Claude Code writes one `assistant` record per
 *    content block, and every record repeats the *same* `message.usage` for the
 *    same `message.id`. Naively summing over-counts by ~2.4x (one real file:
 *    720 records, 301 distinct responses). Records for one id are always
 *    adjacent, so a small ring of recently-seen ids deduplicates them.
 *
 * 2. Subagent spend. `<project>/<sessionId>/subagents/**.jsonl` are real API
 *    calls billed to the user, and their message ids never appear in the parent
 *    transcript (checked: zero overlap). They are counted, and attributed to
 *    the parent session id taken from the directory name.
 *
 *
 * PERFORMANCE
 *
 * The corpus is ~2GB across ~2,350 files. A cold scan streams all of it at
 * ~400MB/s (I/O bound; skipping JSON.parse for lines without a usage object
 * keeps the CPU out of the way). Results are cached per file, keyed by
 * (size, mtime, head fingerprint), and persisted to PROJECT_ROOT so a restart
 * does not rescan. Transcripts are append-only, so a file that grew is parsed
 * from its previous end offset rather than from the start.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { CLAUDE_PROJECTS_DIR, CODEX_SESSIONS_DIR, PROJECT_ROOT } from './config.js';
import { log } from './util.js';

/** Bump when the shape of a cached entry changes; old entries are then discarded. */
const CACHE_VERSION = 2;

const CACHE_PATH = path.join(PROJECT_ROOT, '.usage-cache.json');
const PRICES_PATH = path.join(PROJECT_ROOT, 'usage-prices.json');

/** Files parsed concurrently. The work is I/O bound; more does not help. */
const PARSE_CONCURRENCY = 8;

/** Re-stat the corpus at most this often. Protects against per-request storms. */
const RESCAN_TTL_MS = 2000;

/** Recently-seen message ids kept to deduplicate repeated usage records. */
const DEDUP_WINDOW = 32;

/** Deepest directory nesting walked under a project (project/<uuid>/subagents/workflows/wf_x/). */
const MAX_DEPTH = 8;

/** Bytes read from the end of a Codex rollout to find its last token_count. */
const CODEX_TAIL_BYTES = 512 * 1024;

/**
 * Bytes read from the START of a rollout to find its model.
 *
 * `turn_context` is written near the top (median line 7, worst case line 30
 * across the rollouts here) and is usually far outside the tail window, so a
 * tail-only read left 30 of 136 sessions with an unknown model and priced them
 * off the fallback rate. 64KB recovers it for 135 of 145 files.
 */
const CODEX_HEAD_BYTES = 64 * 1024;

/** Order of the packed per-model tuple stored in the cache. */
const T_INPUT = 0;
const T_OUTPUT = 1;
const T_CACHE_READ = 2;
const T_CACHE_WRITE_5M = 3;
const T_CACHE_WRITE_1H = 4;
const T_REQUESTS = 5;
const T_WEB_SEARCH = 6;
const T_WEB_FETCH = 7;
const TUPLE_LEN = 8;

/* ------------------------------------------------------------------ *
 * Price table
 * ------------------------------------------------------------------ */

let priceCache = null; // { mtimeMs, table }

const DEFAULT_PRICES = {
  currency: 'USD',
  updatedAt: '2026-08-12',
  source: 'estimate — edit usage-prices.json',
  serverTools: { webSearchPerThousandRequests: 10, webFetchPerThousandRequests: 0 },
  models: {
    'claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20 },
    'claude-mythos-5': { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20 },
    'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
    'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
    'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
    'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
    'claude-opus-4-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
    'claude-sonnet-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
    'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
    'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
    'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
    '<synthetic>': { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
  },
  aliases: { opus: 'claude-opus-5', sonnet: 'claude-sonnet-5', haiku: 'claude-haiku-4-5', fable: 'claude-fable-5' },

  // Placeholder rates — see the _README in usage-prices.json. `reasoningOutput`
  // is null on purpose: reasoning tokens are already inside `output`.
  codexRatesArePlaceholders: true,
  codexModels: {
    _default: { input: 1.25, cachedInput: 0.125, output: 10, reasoningOutput: null },
    'gpt-5.6-sol': { input: 1.25, cachedInput: 0.125, output: 10, reasoningOutput: null },
    'gpt-5.6-terra': { input: 1.25, cachedInput: 0.125, output: 10, reasoningOutput: null },
    'gpt-5.5': { input: 1.25, cachedInput: 0.125, output: 10, reasoningOutput: null },
    'gpt-5.4': { input: 1.25, cachedInput: 0.125, output: 10, reasoningOutput: null },
    'gpt-5.4-mini': { input: 0.25, cachedInput: 0.025, output: 2, reasoningOutput: null },
    'gpt-5.3-codex': { input: 1.25, cachedInput: 0.125, output: 10, reasoningOutput: null },
    'gpt-5.1-codex-mini': { input: 0.25, cachedInput: 0.025, output: 2, reasoningOutput: null },
  },
};

/**
 * Load the price table, re-reading it when the file changes so the user can
 * edit prices without restarting the server. Falls back to the built-in
 * defaults (and writes them out) if the file is missing or unparseable.
 */
export function loadPrices() {
  let stat = null;
  try {
    stat = fs.statSync(PRICES_PATH);
  } catch {
    /* missing — handled below */
  }

  if (stat && priceCache && priceCache.mtimeMs === stat.mtimeMs) return priceCache.table;

  let table = DEFAULT_PRICES;
  if (stat) {
    try {
      const parsed = JSON.parse(fs.readFileSync(PRICES_PATH, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.models) table = parsed;
      else log.warn(`${PRICES_PATH} has no "models" object; using built-in defaults`);
    } catch (err) {
      log.warn(`cannot parse ${PRICES_PATH} (${err.message}); using built-in defaults`);
    }
  } else {
    try {
      fs.writeFileSync(PRICES_PATH, `${JSON.stringify(DEFAULT_PRICES, null, 2)}\n`, { mode: 0o644 });
      log.info(`wrote default price table to ${PRICES_PATH}`);
    } catch (err) {
      log.warn(`cannot create ${PRICES_PATH}: ${err.message}`);
    }
  }

  priceCache = { mtimeMs: stat ? stat.mtimeMs : 0, table };
  return table;
}

/**
 * Resolve a model name to a rate card.
 * Tries the exact name, then the alias map, then the name with a trailing
 * -YYYYMMDD snapshot suffix removed (claude-haiku-4-5-20251001 → claude-haiku-4-5).
 */
function rateFor(model, prices) {
  const models = prices.models || {};
  if (models[model]) return models[model];

  const alias = prices.aliases?.[model];
  if (alias && models[alias]) return models[alias];

  const undated = model.replace(/-\d{8}$/, '');
  if (undated !== model && models[undated]) return models[undated];

  return null;
}

/**
 * Codex rate card. Falls back to `_default` rather than returning null, because
 * a new gpt-5.x id appearing is expected and its cost is a placeholder either
 * way — being explicit about that beats reporting the session as unpriced.
 */
function codexRateFor(model, prices) {
  const models = prices.codexModels || {};
  return (model && models[model]) || models._default || null;
}

/**
 * Cost for one Codex session's token totals.
 *
 * Two semantics that differ from Claude and must not be "tidied up":
 *   - `input` is cache-INCLUSIVE, so only the uncached remainder is charged at
 *     the input rate and the cached share is charged at the cheaper one.
 *   - `reasoningOutput` is a subset of `output` (verified on every rollout on
 *     this machine, alongside input + output == total), so it is NEVER added as
 *     its own line. It is disclosed as a figure, not billed as a charge.
 */
function codexCostFor(tokens, rate) {
  if (!rate) return null;
  const uncached = Math.max(0, (tokens.input || 0) - (tokens.inputCached || 0));
  const input = (uncached / 1e6) * (rate.input || 0);
  const cachedInput = ((tokens.inputCached || 0) / 1e6) * (rate.cachedInput || 0);
  const output = ((tokens.output || 0) / 1e6) * (rate.output || 0);
  return {
    input: money(input),
    cachedInput: money(cachedInput),
    output: money(output),
    total: money(input + cachedInput + output),
  };
}

function zeroCodexCost() {
  return { input: 0, cachedInput: 0, output: 0, total: 0 };
}

/* ------------------------------------------------------------------ *
 * Totals helpers
 * ------------------------------------------------------------------ */

function emptyTuple() {
  return new Array(TUPLE_LEN).fill(0);
}

function addTuple(into, from) {
  for (let i = 0; i < TUPLE_LEN; i++) into[i] += from[i] || 0;
}

/** A mutable {model -> tuple} accumulator. */
function addInto(byModel, model, tuple) {
  let slot = byModel.get(model);
  if (!slot) {
    slot = emptyTuple();
    byModel.set(model, slot);
  }
  addTuple(slot, tuple);
}

function tupleToTokens(t) {
  return {
    input: t[T_INPUT],
    output: t[T_OUTPUT],
    cacheRead: t[T_CACHE_READ],
    cacheWrite: t[T_CACHE_WRITE_5M] + t[T_CACHE_WRITE_1H],
    cacheWrite5m: t[T_CACHE_WRITE_5M],
    cacheWrite1h: t[T_CACHE_WRITE_1H],
  };
}

function money(n) {
  return Math.round(n * 1e6) / 1e6;
}

/** Cost for one model's tuple, or null when the model has no rate card. */
function costForModel(model, t, prices) {
  const rate = rateFor(model, prices);
  if (!rate) return null;

  const st = prices.serverTools || {};
  const input = (t[T_INPUT] / 1e6) * (rate.input || 0);
  const output = (t[T_OUTPUT] / 1e6) * (rate.output || 0);
  const cacheRead = (t[T_CACHE_READ] / 1e6) * (rate.cacheRead || 0);
  const cacheWrite =
    (t[T_CACHE_WRITE_5M] / 1e6) * (rate.cacheWrite5m || 0) +
    (t[T_CACHE_WRITE_1H] / 1e6) * (rate.cacheWrite1h || 0);
  const serverTools =
    (t[T_WEB_SEARCH] / 1000) * (st.webSearchPerThousandRequests || 0) +
    (t[T_WEB_FETCH] / 1000) * (st.webFetchPerThousandRequests || 0);

  return {
    input: money(input),
    output: money(output),
    cacheRead: money(cacheRead),
    cacheWrite: money(cacheWrite),
    serverTools: money(serverTools),
    total: money(input + output + cacheRead + cacheWrite + serverTools),
  };
}

function zeroCost() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, serverTools: 0, total: 0 };
}

function addCost(into, from) {
  for (const k of Object.keys(into)) into[k] = money(into[k] + (from[k] || 0));
}

/**
 * Roll a {model -> tuple} map into the response shape used everywhere:
 * per-model rows plus a combined total, with cost flagged as an estimate and
 * any model lacking a rate card named explicitly.
 */
function summarize(byModel, prices) {
  const rows = [];
  const combined = emptyTuple();
  const cost = zeroCost();
  const unpriced = [];

  for (const [model, t] of byModel) {
    addTuple(combined, t);
    const modelCost = costForModel(model, t, prices);
    if (modelCost) addCost(cost, modelCost);
    else if (!unpriced.includes(model)) unpriced.push(model);

    rows.push({
      model,
      requests: t[T_REQUESTS],
      tokens: tupleToTokens(t),
      serverToolUse: { webSearch: t[T_WEB_SEARCH], webFetch: t[T_WEB_FETCH] },
      cost: modelCost,
    });
  }

  rows.sort((a, b) => (b.cost?.total ?? 0) - (a.cost?.total ?? 0) || b.tokens.output - a.tokens.output);

  return {
    requests: combined[T_REQUESTS],
    tokens: tupleToTokens(combined),
    serverToolUse: { webSearch: combined[T_WEB_SEARCH], webFetch: combined[T_WEB_FETCH] },
    cost: {
      ...cost,
      currency: prices.currency || 'USD',
      estimated: true,
      complete: unpriced.length === 0,
      unpricedModels: unpriced,
    },
    byModel: rows,
  };
}

/* ------------------------------------------------------------------ *
 * Parsing one transcript
 * ------------------------------------------------------------------ */

/**
 * Extract the balanced object that starts at `from` (the '{' after "usage":).
 * Cheaper and far less allocation-heavy than JSON.parse on a line whose content
 * blocks can run to megabytes.
 */
function sliceObject(line, from) {
  let depth = 0;
  for (let i = from; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      i++;
      while (i < line.length) {
        if (line[i] === '\\') i++;
        else if (line[i] === '"') break;
        i++;
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return line.slice(from, i + 1);
    }
  }
  return null;
}

// message.model and message.id both precede the (potentially huge) content
// array, and the record's own timestamp precedes the message object, so the
// first match of each is the one we want.
const MODEL_RE = /"model":"([^"]{1,80})"/;
const MSGID_RE = /"id":"(msg_[A-Za-z0-9_-]{1,64})"/;
const TS_RE = /"timestamp":"([^"]{1,40})"/;

function dayKey(ms) {
  const d = new Date(ms);
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * Stream a byte range of one transcript and accumulate usage into `acc`.
 *
 * @param {{days:Object, firstTs:number|null, lastTs:number|null, requests:number, recent:string[]}} acc
 * @returns {Promise<void>}
 */
async function parseRange(filePath, start, end, fallbackMs, acc) {
  if (end <= start) return;

  const stream = fs.createReadStream(filePath, {
    flags: 'r', // read-only: never create, never truncate
    encoding: 'utf8',
    start,
    end: end - 1, // createReadStream's `end` is inclusive
    highWaterMark: 1 << 20,
  });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const recent = acc.recent;
  const recentSet = new Set(recent);

  try {
    for await (const line of rl) {
      const u = line.indexOf('"usage":{');
      if (u < 0) continue;
      // Guard against a tool_result echoing the word "usage": only a real
      // assistant record has both markers.
      if (line.indexOf('"type":"assistant"') < 0) continue;

      const msgId = MSGID_RE.exec(line)?.[1] || null;
      if (msgId) {
        if (recentSet.has(msgId)) continue; // same API response, next content block
        recent.push(msgId);
        recentSet.add(msgId);
        if (recent.length > DEDUP_WINDOW) recentSet.delete(recent.shift());
      }

      const raw = sliceObject(line, u + 8);
      if (!raw) continue;
      let usage;
      try {
        usage = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!usage || typeof usage !== 'object') continue;

      const model = MODEL_RE.exec(line)?.[1];
      if (!model) continue;

      const input = Number(usage.input_tokens) || 0;
      const output = Number(usage.output_tokens) || 0;
      const cacheRead = Number(usage.cache_read_input_tokens) || 0;
      const cacheCreate = Number(usage.cache_creation_input_tokens) || 0;

      // Newer transcripts split cache writes by TTL; a 1h write costs 2x input
      // while a 5m write costs 1.25x, so the split is worth honouring. Older
      // records without it are attributed to the API default (5m).
      let write5m = cacheCreate;
      let write1h = 0;
      const split = usage.cache_creation;
      if (split && typeof split === 'object') {
        const s5 = Number(split.ephemeral_5m_input_tokens) || 0;
        const s1 = Number(split.ephemeral_1h_input_tokens) || 0;
        if (s5 + s1 > 0) {
          write5m = s5;
          write1h = s1;
        }
      }

      const stu = usage.server_tool_use;
      const webSearch = Number(stu?.web_search_requests) || 0;
      const webFetch = Number(stu?.web_fetch_requests) || 0;

      const tsText = TS_RE.exec(line)?.[1];
      const ms = (tsText ? Date.parse(tsText) : NaN) || fallbackMs;
      if (acc.firstTs == null || ms < acc.firstTs) acc.firstTs = ms;
      if (acc.lastTs == null || ms > acc.lastTs) acc.lastTs = ms;

      const key = dayKey(ms);
      let day = acc.days[key];
      if (!day) day = acc.days[key] = {};
      let tuple = day[model];
      if (!tuple) tuple = day[model] = emptyTuple();

      tuple[T_INPUT] += input;
      tuple[T_OUTPUT] += output;
      tuple[T_CACHE_READ] += cacheRead;
      tuple[T_CACHE_WRITE_5M] += write5m;
      tuple[T_CACHE_WRITE_1H] += write1h;
      tuple[T_REQUESTS] += 1;
      tuple[T_WEB_SEARCH] += webSearch;
      tuple[T_WEB_FETCH] += webFetch;
      acc.requests += 1;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

/**
 * Byte offset just past the last complete line, so an incremental parse never
 * consumes a half-written record. Returns -1 if no line boundary was found.
 */
async function completeEnd(fh, size) {
  if (size === 0) return 0;
  const one = Buffer.allocUnsafe(1);
  await fh.read(one, 0, 1, size - 1);
  if (one[0] === 0x0a) return size;

  for (let chunk = 64 * 1024; ; chunk *= 8) {
    const start = Math.max(0, size - chunk);
    const len = size - start;
    const buf = Buffer.allocUnsafe(len);
    await fh.read(buf, 0, len, start);
    const idx = buf.lastIndexOf(0x0a);
    if (idx >= 0) return start + idx + 1;
    if (start === 0) return 0;
    if (chunk > 4 * 1024 * 1024) return -1;
  }
}

/** Fingerprint of the file head, so a rewritten file is not mistaken for an appended one. */
async function headFingerprint(fh, size) {
  const len = Math.min(size, 512);
  if (len === 0) return 'empty';
  const buf = Buffer.allocUnsafe(len);
  await fh.read(buf, 0, len, 0);
  return crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
}

/**
 * Parse (or incrementally extend) one transcript.
 *
 * @param {object|null} prev previous cache entry for this path
 * @returns {Promise<object|null>} a fresh cache entry
 */
async function parseFile(filePath, stat, meta, prev) {
  const fh = await fsp.open(filePath, 'r'); // 'r' — read-only, never creates
  try {
    const head = await headFingerprint(fh, stat.size);
    const end = await completeEnd(fh, stat.size);
    if (end < 0) return prev || null; // pathological single-line file; leave it alone

    const canExtend =
      prev &&
      prev.v === CACHE_VERSION &&
      prev.head === head &&
      typeof prev.parsedBytes === 'number' &&
      prev.parsedBytes <= end;

    const acc = canExtend
      ? {
          days: prev.days,
          firstTs: prev.firstTs,
          lastTs: prev.lastTs,
          requests: prev.requests,
          recent: Array.isArray(prev.recent) ? prev.recent.slice() : [],
        }
      : { days: {}, firstTs: null, lastTs: null, requests: 0, recent: [] };

    const start = canExtend ? prev.parsedBytes : 0;
    await parseRange(filePath, start, end, stat.mtimeMs, acc);

    return {
      v: CACHE_VERSION,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      parsedBytes: end,
      head,
      sessionId: meta.sessionId,
      projectDirName: meta.projectDirName,
      kind: meta.kind,
      rel: meta.rel,
      firstTs: acc.firstTs,
      lastTs: acc.lastTs,
      requests: acc.requests,
      days: acc.days,
      recent: acc.recent.slice(-DEDUP_WINDOW),
      extended: canExtend && start > 0,
    };
  } finally {
    await fh.close();
  }
}

/* ------------------------------------------------------------------ *
 * Corpus scan
 * ------------------------------------------------------------------ */

/** path -> cache entry */
const index = new Map();
/** projectDirName -> resolved cwd, learned from transcripts.js-style decoding */
let lastScan = { at: 0, ms: 0, files: 0, parsed: 0, bytesParsed: 0, cold: true };
let scanPromise = null;
let cacheLoaded = false;
let cacheDirty = false;

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Same lossy decoding transcripts.js uses; only a fallback for display. */
function decodeProjectDirName(name) {
  if (!name.startsWith('-')) return name;
  return `/${name.slice(1).replace(/-/g, '/')}`;
}

function loadCacheFromDisk() {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    if (raw?.v !== CACHE_VERSION || !raw.files) return;
    for (const [p, entry] of Object.entries(raw.files)) {
      if (entry && entry.v === CACHE_VERSION) index.set(p, entry);
    }
    // Codex rollouts run to hundreds of megabytes each; re-reading their tails
    // on every server start is the one cost worth carrying across restarts.
    for (const [p, hit] of Object.entries(raw.codex || {})) {
      if (hit && typeof hit.size === 'number') codexCache.set(p, hit);
    }
    log.info(
      `usage: loaded ${index.size} cached transcripts and ${codexCache.size} rollouts `
      + `from ${path.basename(CACHE_PATH)}`,
    );
  } catch (err) {
    if (err.code !== 'ENOENT') log.debug(`usage: cache unreadable (${err.message}); starting cold`);
  }
}

async function persistCache() {
  if (!cacheDirty) return;
  cacheDirty = false;
  const payload = {
    v: CACHE_VERSION,
    savedAt: Date.now(),
    files: Object.fromEntries(index),
    codex: Object.fromEntries(codexCache),
  };
  const tmp = `${CACHE_PATH}.${process.pid}.tmp`;
  try {
    await fsp.writeFile(tmp, JSON.stringify(payload), { mode: 0o600 });
    await fsp.rename(tmp, CACHE_PATH); // atomic swap; readers never see a partial file
  } catch (err) {
    log.warn(`usage: cannot persist cache: ${err.message}`);
    try {
      await fsp.unlink(tmp);
    } catch {
      /* nothing to clean up */
    }
  }
}

/** Every .jsonl under a project directory, classified as session or subagent log. */
async function collectProject(projectDirName, dir, depth, sessionHint, out) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth >= MAX_DEPTH) continue;
      // <project>/<sessionId>/... carries the parent session in its directory name.
      const hint = sessionHint || (UUID_RE.test(e.name) ? e.name : null);
      await collectProject(projectDirName, full, depth + 1, hint, out);
    } else if (e.isFile() && e.name.endsWith('.jsonl')) {
      out.push({
        file: full,
        projectDirName,
        kind: depth === 0 ? 'session' : 'subagent',
        sessionId: depth === 0 ? path.basename(e.name, '.jsonl') : sessionHint,
        rel: path.relative(path.join(CLAUDE_PROJECTS_DIR, projectDirName), full),
      });
    }
  }
}

/**
 * Bring the in-memory index up to date. Unchanged files cost one stat; changed
 * files are parsed (incrementally when they merely grew).
 */
async function scan({ force = false } = {}) {
  loadCacheFromDisk();

  if (!force && Date.now() - lastScan.at < RESCAN_TTL_MS) return lastScan;
  if (scanPromise) return scanPromise;

  scanPromise = (async () => {
    const t0 = Date.now();
    const cold = index.size === 0;

    let projectDirs = [];
    try {
      projectDirs = await fsp.readdir(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
    } catch (err) {
      log.warn(`usage: cannot read ${CLAUDE_PROJECTS_DIR}: ${err.message}`);
    }

    const targets = [];
    for (const d of projectDirs) {
      if (!d.isDirectory()) continue;
      await collectProject(d.name, path.join(CLAUDE_PROJECTS_DIR, d.name), 0, null, targets);
    }

    const seen = new Set();
    let parsed = 0;
    let bytesParsed = 0;
    let cursor = 0;

    await Promise.all(
      Array.from({ length: PARSE_CONCURRENCY }, async () => {
        while (cursor < targets.length) {
          const t = targets[cursor++];
          seen.add(t.file);

          let stat;
          try {
            stat = await fsp.stat(t.file);
          } catch {
            continue;
          }

          const prev = index.get(t.file);
          if (prev && prev.v === CACHE_VERSION && prev.size === stat.size && prev.mtimeMs === stat.mtimeMs) {
            continue; // untouched since last scan
          }

          try {
            const entry = await parseFile(t.file, stat, t, prev);
            if (entry) {
              const from = entry.extended && prev ? prev.parsedBytes : 0;
              bytesParsed += Math.max(0, entry.parsedBytes - from);
              parsed += 1;
              index.set(t.file, entry);
              cacheDirty = true;
            }
          } catch (err) {
            log.debug(`usage: cannot parse ${t.file}: ${err.message}`);
          }
        }
      }),
    );

    for (const key of index.keys()) {
      if (!seen.has(key)) {
        index.delete(key);
        cacheDirty = true;
      }
    }

    lastScan = {
      at: Date.now(),
      ms: Date.now() - t0,
      files: targets.length,
      parsed,
      bytesParsed,
      cold,
    };

    await persistCache();
    return lastScan;
  })();

  try {
    return await scanPromise;
  } finally {
    scanPromise = null;
  }
}

/* ------------------------------------------------------------------ *
 * Window selection
 * ------------------------------------------------------------------ */

const WINDOWS = new Set(['today', '7d', '30d', 'all']);

export function normaliseWindow(value) {
  const w = typeof value === 'string' ? value.trim() : '';
  return WINDOWS.has(w) ? w : 'all';
}

/** Inclusive lower bound as a YYYY-MM-DD key, or null for "all". */
function windowFloor(window) {
  if (window === 'all') return null;
  const days = window === 'today' ? 0 : window === '7d' ? 6 : 29;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return dayKey(d.getTime());
}

/** Walk every (day, model, tuple) in an entry that falls inside the window. */
function eachDay(entry, floor, fn) {
  for (const [day, models] of Object.entries(entry.days)) {
    if (floor && day < floor) continue;
    for (const [model, tuple] of Object.entries(models)) fn(day, model, tuple);
  }
}

function entryHasData(entry, floor) {
  if (!floor) return entry.requests > 0;
  for (const day of Object.keys(entry.days)) if (day >= floor) return true;
  return false;
}

/* ------------------------------------------------------------------ *
 * Public queries — Claude
 * ------------------------------------------------------------------ */

function scanMeta() {
  return {
    files: lastScan.files,
    parsedThisScan: lastScan.parsed,
    scanMs: lastScan.ms,
    cold: lastScan.cold,
    cachePath: CACHE_PATH,
  };
}

/**
 * Codex, condensed for the dashboard header.
 *
 * Deliberately NOT merged into the Claude totals: Codex's input is
 * cache-inclusive and has no cache-write bucket, so a combined "all tools"
 * token figure would be adding quantities that do not mean the same thing. The
 * two are shown side by side instead, each with its own caveat.
 */
async function codexSummary() {
  const full = await codexUsage();
  return {
    available: full.tokenAccounting.available,
    endpoint: '/api/usage/codex',
    sessions: full.count,
    tokens: full.totals,
    cost: full.cost,
    costPlaceholder: full.costPlaceholder,
    costReason: full.costReason,
    caveat: full.tokenAccounting.caveat,
    reasoningOutputIncludedInOutput: true,
    comparableWithClaude: false,
  };
}

function priceMeta(prices) {
  return {
    path: PRICES_PATH,
    currency: prices.currency || 'USD',
    updatedAt: prices.updatedAt || null,
    source: prices.source || null,
    note: 'All costs are estimates from a user-editable price table, not billed amounts.',
  };
}

/**
 * GET /api/usage?window=...
 * Dashboard: totals by model, a daily series, and the heaviest projects/sessions.
 */
export async function overview({ window = 'all', topProjects = 8, topSessions = 8 } = {}) {
  await scan();
  const prices = loadPrices();
  const floor = windowFloor(window);

  const byModel = new Map();
  const byDay = new Map(); // day -> Map(model -> tuple)
  const byProject = new Map();
  const bySession = new Map();

  for (const entry of index.values()) {
    eachDay(entry, floor, (day, model, tuple) => {
      addInto(byModel, model, tuple);

      let dayModels = byDay.get(day);
      if (!dayModels) byDay.set(day, (dayModels = new Map()));
      addInto(dayModels, model, tuple);

      let proj = byProject.get(entry.projectDirName);
      if (!proj) byProject.set(entry.projectDirName, (proj = new Map()));
      addInto(proj, model, tuple);

      if (entry.sessionId) {
        const key = `${entry.projectDirName}/${entry.sessionId}`;
        let sess = bySession.get(key);
        if (!sess) bySession.set(key, (sess = { models: new Map(), lastTs: 0 }));
        addInto(sess.models, model, tuple);
        if ((entry.lastTs || 0) > sess.lastTs) sess.lastTs = entry.lastTs || 0;
      }
    });
  }

  const daily = [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([day, models]) => {
      const s = summarize(models, prices);
      return { day, requests: s.requests, tokens: s.tokens, cost: s.cost.total };
    });

  const projects = [...byProject.entries()]
    .map(([projectDirName, models]) => {
      const s = summarize(models, prices);
      return {
        projectDirName,
        projectDir: decodeProjectDirName(projectDirName),
        requests: s.requests,
        tokens: s.tokens,
        cost: s.cost,
      };
    })
    .sort((a, b) => b.cost.total - a.cost.total)
    .slice(0, topProjects);

  const sessions = [...bySession.entries()]
    .map(([key, v]) => {
      const s = summarize(v.models, prices);
      const slash = key.lastIndexOf('/');
      return {
        sessionId: key.slice(slash + 1),
        projectDirName: key.slice(0, slash),
        lastActivity: v.lastTs || null,
        requests: s.requests,
        tokens: s.tokens,
        cost: s.cost,
      };
    })
    .sort((a, b) => b.cost.total - a.cost.total)
    .slice(0, topSessions);

  return {
    window,
    since: floor,
    ...summarize(byModel, prices),
    daily,
    topProjects: projects,
    topSessions: sessions,
    prices: priceMeta(prices),
    scan: scanMeta(),
    codex: await codexSummary(),
  };
}

/** GET /api/usage/projects?window=... */
export async function projectUsage({ window = 'all' } = {}) {
  await scan();
  const prices = loadPrices();
  const floor = windowFloor(window);

  const byProject = new Map(); // projectDirName -> { models, sessions:Set, lastTs }

  for (const entry of index.values()) {
    eachDay(entry, floor, (_day, model, tuple) => {
      let p = byProject.get(entry.projectDirName);
      if (!p) byProject.set(entry.projectDirName, (p = { models: new Map(), sessions: new Set(), lastTs: 0 }));
      addInto(p.models, model, tuple);
      if (entry.sessionId) p.sessions.add(entry.sessionId);
      if ((entry.lastTs || 0) > p.lastTs) p.lastTs = entry.lastTs || 0;
    });
  }

  const projects = [...byProject.entries()]
    .map(([projectDirName, p]) => ({
      projectDirName,
      projectDir: decodeProjectDirName(projectDirName),
      sessions: p.sessions.size,
      lastActivity: p.lastTs || null,
      ...summarize(p.models, prices),
    }))
    .sort((a, b) => b.cost.total - a.cost.total);

  const grand = new Map();
  for (const p of byProject.values()) for (const [m, t] of p.models) addInto(grand, m, t);

  return {
    window,
    since: floor,
    projects,
    total: summarize(grand, prices),
    prices: priceMeta(prices),
    scan: scanMeta(),
  };
}

/** Accept a bare uuid, or the unified `dormant:<projectDirName>/<uuid>` session id. */
export function parseSessionRef(id) {
  if (typeof id !== 'string' || !id) return null;
  let rest = id.startsWith('dormant:') ? id.slice(8) : id;
  if (rest.startsWith('live:')) return null; // a live tmux name is not a transcript id
  let projectDirName = null;
  const slash = rest.lastIndexOf('/');
  if (slash > 0) {
    projectDirName = rest.slice(0, slash);
    rest = rest.slice(slash + 1);
  }
  // Ids are used only as map keys here, never as path segments, but reject the
  // obviously hostile shapes anyway.
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(rest)) return null;
  if (projectDirName && (projectDirName.includes('/') || projectDirName.includes('..'))) return null;
  return { sessionId: rest, projectDirName };
}

/**
 * GET /api/usage/session/:id
 * Main-thread and subagent spend for one session, split by model.
 */
export async function sessionUsage(id, { window = 'all' } = {}) {
  const ref = parseSessionRef(id);
  if (!ref) return null;

  await scan();
  const prices = loadPrices();
  const floor = windowFloor(window);

  const all = new Map();
  const main = new Map();
  const sub = new Map();
  let projectDirName = ref.projectDirName;
  let firstTs = null;
  let lastTs = null;
  let files = 0;
  let subagentFiles = 0;
  let found = false;

  for (const entry of index.values()) {
    if (entry.sessionId !== ref.sessionId) continue;
    if (ref.projectDirName && entry.projectDirName !== ref.projectDirName) continue;
    found = true;
    files += 1;
    if (entry.kind === 'subagent') subagentFiles += 1;
    projectDirName = projectDirName || entry.projectDirName;
    if (entry.firstTs != null && (firstTs == null || entry.firstTs < firstTs)) firstTs = entry.firstTs;
    if (entry.lastTs != null && (lastTs == null || entry.lastTs > lastTs)) lastTs = entry.lastTs;

    eachDay(entry, floor, (_day, model, tuple) => {
      addInto(all, model, tuple);
      addInto(entry.kind === 'subagent' ? sub : main, model, tuple);
    });
  }

  if (!found) return null;

  return {
    sessionId: ref.sessionId,
    projectDirName,
    projectDir: projectDirName ? decodeProjectDirName(projectDirName) : null,
    window,
    since: floor,
    firstActivity: firstTs,
    lastActivity: lastTs,
    files,
    subagentFiles,
    ...summarize(all, prices),
    breakdown: {
      main: summarize(main, prices),
      subagents: { files: subagentFiles, ...summarize(sub, prices) },
    },
    prices: priceMeta(prices),
    scan: scanMeta(),
  };
}

/**
 * GET /api/usage/sessions?window=...&limit=...
 * Compact rows meant to be merged into the session list: four token buckets,
 * a cost estimate, and the dominant model. No per-model array, no daily series.
 */
export async function sessionSummaries({ window = 'all', limit = 500 } = {}) {
  await scan();
  const prices = loadPrices();
  const floor = windowFloor(window);

  const bySession = new Map();

  for (const entry of index.values()) {
    if (!entry.sessionId) continue;
    if (!entryHasData(entry, floor)) continue;
    const key = `${entry.projectDirName}/${entry.sessionId}`;
    let s = bySession.get(key);
    if (!s) {
      bySession.set(key, (s = { models: new Map(), lastTs: 0, subagentFiles: 0, projectDirName: entry.projectDirName }));
    }
    if (entry.kind === 'subagent') s.subagentFiles += 1;
    if ((entry.lastTs || 0) > s.lastTs) s.lastTs = entry.lastTs || 0;
    eachDay(entry, floor, (_day, model, tuple) => addInto(s.models, model, tuple));
  }

  const rows = [];
  for (const [key, s] of bySession) {
    const sum = summarize(s.models, prices);
    if (sum.requests === 0) continue;
    const slash = key.lastIndexOf('/');
    rows.push({
      id: `dormant:${key}`,
      sessionId: key.slice(slash + 1),
      projectDirName: s.projectDirName,
      lastActivity: s.lastTs || null,
      requests: sum.requests,
      subagentFiles: s.subagentFiles,
      tokens: sum.tokens,
      topModel: sum.byModel[0]?.model || null,
      models: sum.byModel.map((m) => m.model),
      cost: sum.cost.total,
      costEstimated: true,
      costComplete: sum.cost.complete,
      currency: sum.cost.currency,
    });
  }

  rows.sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
  const capped = rows.slice(0, Math.max(1, Math.min(2000, limit)));

  return {
    window,
    since: floor,
    count: capped.length,
    totalSessions: rows.length,
    sessions: capped,
    prices: priceMeta(prices),
    scan: scanMeta(),
  };
}

/** GET /api/usage/prices — expose the table so the UI can show and link it. */
export function prices() {
  const table = loadPrices();
  return {
    ...priceMeta(table),
    editable: true,
    serverTools: table.serverTools || {},
    models: table.models || {},
    aliases: table.aliases || {},
    codexModels: table.codexModels || {},
    codexRatesArePlaceholders: table.codexRatesArePlaceholders !== false,
    // Reasoning tokens are inside `output`; the table carries a null for them so
    // nobody "fixes" the gap by pricing them a second time.
    codexNote:
      'Codex input is cache-inclusive (only the uncached remainder is charged at the input rate) and '
      + 'reasoningOutput is a subset of output, so it is disclosed but never charged separately.',
  };
}

export async function refresh() {
  const [claude, codex] = await Promise.all([scan({ force: true }), codexRescan({ force: true })]);
  return { ...claude, codex };
}

/* ------------------------------------------------------------------ *
 * Codex
 * ------------------------------------------------------------------ */

const CODEX_CAVEAT =
  'Codex reports input (cache-inclusive), cached input, output and reasoning output. There is no cache-write ' +
  'bucket, and its input already contains the cached share, so these figures are not comparable line-for-line ' +
  'with the Claude ones.';

const CODEX_PLACEHOLDER_REASON =
  'Codex costs use PLACEHOLDER rates: no published rate card for these gpt-5.x model ids was available when ' +
  'usage-prices.json was written. The token counts are real; the money is an order-of-magnitude shape, not a ' +
  'bill. Edit codexModels in usage-prices.json to make it meaningful.';

const codexCache = new Map(); // path -> { size, mtimeMs, entry }

/**
 * The rollout corpus is re-walked at most this often. Without it, every request
 * re-readdir'd 35 dated directories and re-stat'd 145 files — ~250ms of syscalls
 * to usually learn that nothing had changed.
 */
let codexScan = { at: 0, ms: 0, files: 0, parsed: 0, cold: true };
let codexScanPromise = null;

const ROLLOUT_RE = /^rollout-.*?-([0-9a-fA-F-]{36})\.jsonl$/;

async function listRollouts(dir, depth, out) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory() && depth < 3) await listRollouts(full, depth + 1, out);
    else if (e.isFile() && ROLLOUT_RE.test(e.name)) out.push(full);
  }
  return out;
}

/**
 * Read one rollout's accounting.
 *
 * `total_token_usage` is cumulative and monotonic (verified across the largest
 * rollouts on this machine), so the last token_count record in the file is the
 * session total — which means only the tail needs reading, and a 382MB rollout
 * costs the same as a 1MB one.
 */
async function parseRollout(filePath, stat) {
  const fh = await fsp.open(filePath, 'r'); // 'r' — read-only
  try {
    const start = Math.max(0, stat.size - CODEX_TAIL_BYTES);
    const len = stat.size - start;
    if (len <= 0) return null;
    const buf = Buffer.allocUnsafe(len);
    const { bytesRead } = await fh.read(buf, 0, len, start);
    let text = buf.toString('utf8', 0, bytesRead);
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }

    // The model lives at the top of the file, which the tail window usually
    // misses entirely on a multi-hundred-megabyte rollout.
    const headModel = start > 0 ? await readRolloutModel(fh, stat) : null;

    let total = null;
    let model = null;
    let lastTs = null;
    let events = 0;

    for (const line of text.split('\n')) {
      if (!line) continue;
      const hasCount = line.includes('token_count');
      const hasCtx = line.includes('turn_context');
      if (!hasCount && !hasCtx) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (hasCtx && rec.type === 'turn_context' && rec.payload?.model) model = rec.payload.model;
      const info = rec.payload?.type === 'token_count' ? rec.payload.info : null;
      if (!info?.total_token_usage) continue;
      events += 1;
      total = info.total_token_usage;
      if (rec.timestamp) lastTs = rec.timestamp;
    }

    if (!total) return null;

    const input = Number(total.input_tokens) || 0;
    const cached = Number(total.cached_input_tokens) || 0;
    return {
      sessionId: ROLLOUT_RE.exec(path.basename(filePath))?.[1] || null,
      file: filePath,
      // Prefer the last turn_context in the tail (a session can switch models
      // mid-run and the later one priced most of the work); fall back to the
      // one at the top of the file.
      model: model || headModel,
      lastActivity: (lastTs ? Date.parse(lastTs) : null) || stat.mtimeMs,
      tokenCountEvents: events,
      tokens: {
        // Codex's input_tokens INCLUDES cached_input_tokens (input + output ==
        // total_tokens in every record checked), so the uncached remainder is
        // the difference — reported explicitly so nothing has to be inferred.
        input,
        inputCached: cached,
        inputUncached: Math.max(0, input - cached),
        output: Number(total.output_tokens) || 0,
        reasoningOutput: Number(total.reasoning_output_tokens) || 0,
        total: Number(total.total_tokens) || 0,
      },
    };
  } finally {
    await fh.close();
  }
}

/** The model id from a rollout's opening records, or null. Read-only, head only. */
async function readRolloutModel(fh, stat) {
  const len = Math.min(CODEX_HEAD_BYTES, stat.size);
  if (len <= 0) return null;
  const buf = Buffer.allocUnsafe(len);
  const { bytesRead } = await fh.read(buf, 0, len, 0);
  const text = buf.toString('utf8', 0, bytesRead);
  for (const line of text.split('\n')) {
    if (!line.includes('turn_context')) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // a truncated last line in the window is expected
    }
    if (rec.type === 'turn_context' && rec.payload?.model) return rec.payload.model;
  }
  return null;
}

/**
 * GET /api/usage/codex
 *
 * Deliberately shaped so a client cannot mistake "no price" for "free":
 * `cost` is null everywhere and `costAvailable` is false with a stated reason.
 */
/**
 * Bring the rollout index up to date, at most once per RESCAN_TTL_MS.
 *
 * Same contract as the Claude scan: an unchanged file costs one stat, a changed
 * one costs a tail read. Entries persist to .usage-cache.json, so a restart does
 * not re-read 2.2GB of rollouts.
 */
async function codexRescan({ force = false } = {}) {
  loadCacheFromDisk();
  if (!force && Date.now() - codexScan.at < RESCAN_TTL_MS) return codexScan;
  if (codexScanPromise) return codexScanPromise;

  codexScanPromise = (async () => {
    const t0 = Date.now();
    const cold = codexCache.size === 0;
    const files = await listRollouts(CODEX_SESSIONS_DIR, 0, []);
    const seen = new Set();
    let parsed = 0;

    for (const file of files) {
      seen.add(file);
      let stat;
      try {
        stat = await fsp.stat(file);
      } catch {
        continue;
      }

      const hit = codexCache.get(file);
      if (!force && hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) continue;

      let entry;
      try {
        entry = await parseRollout(file, stat);
      } catch (err) {
        log.debug(`usage: cannot read rollout ${file}: ${err.message}`);
        entry = null;
      }
      codexCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, entry });
      cacheDirty = true;
      parsed += 1;
    }

    for (const key of codexCache.keys()) {
      if (!seen.has(key)) {
        codexCache.delete(key);
        cacheDirty = true;
      }
    }

    codexScan = { at: Date.now(), ms: Date.now() - t0, files: files.length, parsed, cold };
    await persistCache();
    return codexScan;
  })();

  try {
    return await codexScanPromise;
  } finally {
    codexScanPromise = null;
  }
}

/**
 * GET /api/usage/codex
 *
 * Token counts are real, parsed from the rollouts. Cost is priced from the
 * `codexModels` placeholder table and is flagged `placeholder: true` at every
 * level so a client cannot present it with the same confidence as the Claude
 * estimate — which is itself only an estimate.
 */
export async function codexUsage({ id = null, force = false } = {}) {
  await codexRescan({ force });
  const prices = loadPrices();
  const placeholder = prices.codexRatesArePlaceholders !== false;

  const sessions = [];
  for (const hit of codexCache.values()) {
    if (hit?.entry) sessions.push(hit.entry);
  }

  const filtered = id ? sessions.filter((s) => s.sessionId === id) : sessions;
  filtered.sort((a, b) => b.lastActivity - a.lastActivity);

  const totals = { input: 0, inputCached: 0, inputUncached: 0, output: 0, reasoningOutput: 0, total: 0 };
  const byModel = new Map();
  const cost = zeroCodexCost();
  const unpriced = [];

  const priced = filtered.map((s) => {
    for (const k of Object.keys(totals)) totals[k] += s.tokens[k] || 0;

    const rate = codexRateFor(s.model, prices);
    const sessionCost = codexCostFor(s.tokens, rate);
    if (sessionCost) for (const k of Object.keys(cost)) cost[k] = money(cost[k] + sessionCost[k]);
    else if (s.model && !unpriced.includes(s.model)) unpriced.push(s.model);

    const key = s.model || 'unknown';
    let slot = byModel.get(key);
    if (!slot) {
      byModel.set(key, (slot = {
        model: key,
        sessions: 0,
        tokens: { input: 0, inputCached: 0, inputUncached: 0, output: 0, reasoningOutput: 0, total: 0 },
        cost: sessionCost ? zeroCodexCost() : null,
      }));
    }
    slot.sessions += 1;
    for (const k of Object.keys(slot.tokens)) slot.tokens[k] += s.tokens[k] || 0;
    if (slot.cost && sessionCost) for (const k of Object.keys(slot.cost)) slot.cost[k] = money(slot.cost[k] + sessionCost[k]);

    return { ...s, cost: sessionCost, costPlaceholder: placeholder };
  });

  return {
    tokenAccounting: {
      available: filtered.length > 0,
      source: 'rollout JSONL: event_msg → payload.token_count → info.total_token_usage (cumulative, last record wins)',
      notAvailableIn: [
        '~/.codex/logs_2.sqlite — the logs table has no token, usage or cost columns',
        '~/.codex/history.jsonl — only {session_id, text, ts}',
      ],
      caveat: CODEX_CAVEAT,
      // Stated as data rather than left for a client to rediscover: reasoning
      // tokens live inside `output` and are never charged on their own line.
      reasoningOutputIncludedInOutput: true,
    },
    costAvailable: true,
    costPlaceholder: placeholder,
    costReason: placeholder ? CODEX_PLACEHOLDER_REASON : null,
    cost: {
      ...cost,
      currency: prices.currency || 'USD',
      estimated: true,
      placeholder,
      complete: unpriced.length === 0,
      unpricedModels: unpriced,
    },
    byModel: [...byModel.values()].sort((a, b) => (b.cost?.total ?? 0) - (a.cost?.total ?? 0)),
    sessions: priced,
    count: filtered.length,
    totals,
    prices: { ...priceMeta(prices), placeholderRates: placeholder },
    scan: { ...codexScan, cachePath: CACHE_PATH },
  };
}
