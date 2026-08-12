/**
 * The local AI helper — a small model on this Mac that turns English into shell
 * commands the user can run with one tap.
 *
 * ┌─ EXECUTION BOUNDARY — the load-bearing rule of this file ───────────────┐
 * │ NOTHING IN THIS MODULE EVER EXECUTES A COMMAND.                         │
 * │                                                                         │
 * │ The model's job ends at producing text. A command it writes reaches a   │
 * │ shell only when the human reads it and taps "Run" in the client, which  │
 * │ posts it to `POST /api/sessions {command}` like any other session the   │
 * │ user starts by hand. There is no code path here that spawns, that calls │
 * │ createSession(), or that hands a string to a shell — and none may be    │
 * │ added. A 7B model hallucinating `rm -rf` is a wrong suggestion the user │
 * │ can see and discard; an auto-executed one is a destroyed machine.       │
 * │                                                                         │
 * │ Consequently this module imports nothing that can run anything. Its     │
 * │ only outbound network call is to Ollama on loopback.                    │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * TRANSPORT: Server-Sent Events, not the websocket.
 * ws-api.js is a PTY byte broker — a socket there is bound to one tmux session
 * and every frame on it means "these bytes are terminal output for that
 * session". Chat tokens are not that, and carrying them would mean inventing a
 * second message protocol inside a transport built for the first. SSE is
 * one-way server→client, which is exactly the shape of token streaming, it
 * rides the existing authenticated HTTP path (so `checkAuth` already covers it
 * with no second gate to keep in sync), and it needs no attach/detach or
 * reconnect semantics. The client reads it with `fetch` + a stream reader
 * rather than `EventSource`, because EventSource cannot set an Authorization
 * header and the token must never travel in a URL.
 *
 * HARDWARE SAFETY (an M1 Air with 16GB, no fan, and a history of kernel panics
 * under GPU contention — a local model is a GPU workload):
 *   1. SINGLE-FLIGHT. One generation at a time, process-wide. A second request
 *      is refused with 429 and a message naming what is already running; it is
 *      never queued behind an unbounded wait or run alongside.
 *   2. SHORT keep_alive. The model unloads shortly after the user stops
 *      talking instead of sitting in RAM for hours.
 *   3. ONE MODEL RESIDENT. Switching models explicitly unloads the previous
 *      one before loading the next, so two ~5GB models never overlap on a
 *      16GB machine.
 *   4. BOUNDED WORK. num_ctx and num_predict are capped, and a generation that
 *      runs past the wall-clock limit is aborted rather than holding the gate.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LOGIN_SHELL } from './config.js';
import { describeKinds } from './kinds.js';
import { log, summarize } from './util.js';

/* ------------------------------------------------------------------ *
 * Tunables
 * ------------------------------------------------------------------ */

/** Ollama's own listener. Loopback only — this is never a remote endpoint. */
const OLLAMA_URL = (process.env.CCR_OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');

/**
 * Default model. qwen2.5:7b is the pick of the three installed: it is the
 * smallest (4.7GB, so the least memory pressure), it is trained for code, and
 * unlike the deepseek-r1 distill it answers directly instead of emitting a long
 * <think> monologue before a one-line command.
 */
export const DEFAULT_MODEL = process.env.CCR_ASSISTANT_MODEL || 'qwen2.5:7b';

/**
 * How long Ollama keeps the weights resident after a generation. Deliberately
 * short: the phone use case is bursty, and 5GB parked in RAM on a 16GB fanless
 * machine is exactly the state that has panicked this Mac before.
 */
const KEEP_ALIVE = process.env.CCR_OLLAMA_KEEP_ALIVE || '30s';

/** Context window. Small on purpose — KV cache is the other half of the memory bill. */
const NUM_CTX = Number(process.env.CCR_OLLAMA_NUM_CTX || 4096);

/** Hard cap on generated tokens, so a looping model cannot run for ever. */
const NUM_PREDICT = Number(process.env.CCR_OLLAMA_NUM_PREDICT || 700);

/** Wall-clock ceiling for one generation. Past this the gate is forced open. */
const GENERATION_TIMEOUT_MS = Number(process.env.CCR_OLLAMA_TIMEOUT_MS || 300_000);

/** `/api/tags` must answer fast or be treated as down; the UI waits on it. */
const TAGS_TIMEOUT_MS = 4000;

/** Conversation limits — bounds the prompt, and therefore the KV cache. */
const MAX_TURNS = 16;
const MAX_CHARS_PER_MESSAGE = 6000;
const MAX_TOTAL_CHARS = 24_000;

/* ------------------------------------------------------------------ *
 * Single-flight state
 * ------------------------------------------------------------------ */

/**
 * The one in-flight generation, or null. Module-level because the constraint is
 * about this machine's GPU, not about a user or a connection: two phones, two
 * tabs and a curl all have to contend for the same single slot.
 */
let active = null;

/** Last model Ollama was asked to load, so a switch can unload it first. */
let residentModel = null;

let requestSeq = 0;

function busySnapshot() {
  if (!active) return null;
  return {
    model: active.model,
    startedAt: active.startedAt,
    elapsedMs: Date.now() - active.startedAt,
  };
}

/* ------------------------------------------------------------------ *
 * Ollama client
 * ------------------------------------------------------------------ */

class OllamaDown extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'OllamaDown';
    this.code = 'OLLAMA_DOWN';
    this.cause = cause;
  }
}

const DOWN_HINT =
  `No local model server is answering at ${OLLAMA_URL}. Start it with \`ollama serve\` ` +
  '(or open the Ollama app) on the Mac, then try again.';

/**
 * One fetch to Ollama, with a timeout and a uniform "it is not running" error.
 * Everything else in this module goes through here so that a stopped Ollama
 * always surfaces as a clean 503 rather than a hung request — the rest of the
 * app must be entirely unaffected by the model server being absent.
 */
async function ollamaFetch(pathname, { method = 'GET', body, timeoutMs, signal } = {}) {
  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const onOuterAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onOuterAbort, { once: true });
  }

  try {
    const res = await fetch(`${OLLAMA_URL}${pathname}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    return res;
  } catch (err) {
    // An abort we asked for is not an outage; let the caller tell them apart.
    if (signal?.aborted) throw err;
    if (err?.name === 'AbortError') {
      throw new OllamaDown(`${OLLAMA_URL} did not respond within ${timeoutMs}ms. ${DOWN_HINT}`, err);
    }
    throw new OllamaDown(DOWN_HINT, err);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onOuterAbort);
  }
}

/** Models pulled on this machine, newest-modified first. */
export async function listModels() {
  const res = await ollamaFetch('/api/tags', { timeoutMs: TAGS_TIMEOUT_MS });
  if (!res.ok) throw new OllamaDown(`Ollama answered ${res.status} for /api/tags. ${DOWN_HINT}`);
  const payload = await res.json();
  const models = (Array.isArray(payload?.models) ? payload.models : [])
    .map((m) => ({
      name: m.name,
      sizeBytes: m.size ?? null,
      family: m.details?.family ?? null,
      parameterSize: m.details?.parameter_size ?? null,
      quantization: m.details?.quantization_level ?? null,
      // deepseek-r1 emits a reasoning monologue; the client dims it rather than
      // showing the user a wall of self-talk where a command should be.
      thinking: Array.isArray(m.capabilities) && m.capabilities.includes('thinking'),
      modifiedAt: m.modified_at ?? null,
    }))
    .sort((a, b) => String(b.modifiedAt || '').localeCompare(String(a.modifiedAt || '')));
  return models;
}

/**
 * Evict a model from memory. `keep_alive: 0` is Ollama's documented unload.
 * Best-effort: failing to unload must never block the request that wanted to.
 */
async function unloadModel(model) {
  if (!model) return;
  try {
    const res = await ollamaFetch('/api/generate', {
      method: 'POST',
      timeoutMs: 10_000,
      body: { model, prompt: '', keep_alive: 0 },
    });
    // Drain so the socket is returned to the pool rather than left half-read.
    await res.arrayBuffer().catch(() => {});
    log.debug(`assistant: unloaded ${model} to free memory before switching`);
  } catch (err) {
    log.debug(`assistant: could not unload ${model}: ${err.message}`);
  }
}

/* ------------------------------------------------------------------ *
 * Prompt construction
 * ------------------------------------------------------------------ */

/** "macOS 15 (darwin 24.6.0, arm64)" — derived, never shelled out for. */
function describeOs() {
  const release = os.release();
  const arch = os.arch();
  if (os.platform() !== 'darwin') return `${os.platform()} ${release} (${arch})`;
  const darwinMajor = Number.parseInt(release, 10);
  const macMajor = Number.isFinite(darwinMajor) && darwinMajor >= 20 ? darwinMajor - 9 : null;
  return `macOS${macMajor ? ` ${macMajor}` : ''} (darwin ${release}, ${arch})`;
}

/**
 * The system prompt. Everything in it is machine shape — OS, shell, cwd, which
 * CLIs are installed. NO transcript content, NO file contents, NO environment
 * variables, and above all NO auth token: the bearer token is the only thing
 * standing between the internet and a shell here, and a token pasted into a
 * prompt would be echoed back by the model, stored in the client's chat
 * history, and shown on screen. It is never read in this file.
 */
function buildSystemPrompt({ cwd, presets }) {
  const available = presets.filter((p) => p.available).map((p) => p.id);
  const missing = presets.filter((p) => !p.available).map((p) => p.id);

  return [
    'You are the command assistant built into Termlink, an app the user drives from their phone',
    'to control real terminal sessions on their Mac. Typing on a phone is painful, which is the',
    'entire reason you exist: the user describes a job in English and you write the command.',
    '',
    'THIS MACHINE',
    `- OS: ${describeOs()} — BSD userland, not GNU/Linux.`,
    `- Shell: ${LOGIN_SHELL}. Commands you write are run as \`${path.basename(LOGIN_SHELL)} -lc '<your command>'\`,`,
    '  so pipes, &&, globs, redirection and $VAR expansion all work.',
    `- Working directory: ${cwd}`,
    '  A command runs there. Use relative paths for things inside it; do not cd unless asked.',
    `- Session types this app can launch: ${available.join(', ') || 'none detected'}` +
      `${missing.length ? ` (not installed: ${missing.join(', ')})` : ''}.`,
    '',
    'HOW TO ANSWER',
    '1. Lead with at most two short sentences. The screen is a phone; nobody scrolls.',
    '2. Put every command in its own fenced block tagged bash:',
    '   ```bash',
    '   the command',
    '   ```',
    '   The app renders each block as a card with a Run button, so ONE block = ONE thing to run.',
    '   Never put prose, a `$` prompt, comments or example output inside the fence.',
    '3. Prefer a single line. If several steps are genuinely required, join them with && in one',
    '   block, or give separate blocks in the order they should be run.',
    '4. Write macOS/BSD flags, not GNU ones. In particular: `find -size +100M -mtime -7`,',
    '   `stat -f`, `sed -i \'\'`, `date -v-7d`, and no `--time-style`, `-printf`, `-newermt` or',
    '   `du --max-depth`. Use `gfind`/`gsed` only if the user says coreutils is installed.',
    '5. Quote paths that may contain spaces. Send stray permission noise to /dev/null with',
    '   `2>/dev/null` when scanning wide trees like ~ or /.',
    '6. Do not use sudo unless the user asked for something that truly needs root.',
    '7. If a command deletes, overwrites or moves anything, say so in one plain sentence',
    '   immediately before the block. Never bury it after.',
    '8. If the request is ambiguous, make the most useful reasonable assumption, state it in',
    '   half a sentence, and still give the command. Do not reply with only questions.',
    '9. If the user is just asking a question, answer it in prose with no fenced block.',
    '',
    'BOUNDARIES',
    '- You cannot run anything, read files, or see output. You only write text. The user reads',
    '  your command and taps Run if they want it. Never claim to have run or checked something.',
    '- Never ask for, invent, or print passwords, tokens, API keys or the contents of ~/.ssh.',
  ].join('\n');
}

/** Resolve the caller's cwd, falling back to home rather than failing the chat. */
async function resolveCwd(input) {
  const fallback = os.homedir();
  if (typeof input !== 'string' || !input.trim()) return fallback;
  let resolved;
  try {
    resolved = path.resolve(input.trim());
  } catch {
    return fallback;
  }
  try {
    const st = await fsp.stat(resolved);
    if (!st.isDirectory()) return fallback;
    return resolved;
  } catch {
    return fallback;
  }
}

/**
 * Validate and trim the conversation. Only role and content survive — anything
 * else a client might attach (ids, timestamps, rendered HTML) is dropped rather
 * than forwarded into the prompt.
 */
function normaliseMessages(input) {
  if (!Array.isArray(input)) throw new Error('messages must be an array');
  const out = [];
  for (const m of input) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role === 'assistant' ? 'assistant' : m.role === 'user' ? 'user' : null;
    if (!role) continue;
    const content = typeof m.content === 'string' ? m.content : '';
    if (!content.trim()) continue;
    out.push({ role, content: content.slice(0, MAX_CHARS_PER_MESSAGE) });
  }
  if (!out.length) throw new Error('messages must contain at least one user message');
  if (out[out.length - 1].role !== 'user') throw new Error('the last message must be from the user');

  // Keep the most recent turns; the oldest are the cheapest to lose and the
  // prompt has to stay inside NUM_CTX.
  let trimmed = out.slice(-MAX_TURNS);
  while (trimmed.length > 1 && trimmed.reduce((n, m) => n + m.content.length, 0) > MAX_TOTAL_CHARS) {
    trimmed = trimmed.slice(1);
  }
  return trimmed;
}

/* ------------------------------------------------------------------ *
 * SSE plumbing
 * ------------------------------------------------------------------ */

function openSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    // no-transform matters as much as no-store: a proxy that buffers or
    // recompresses this stream turns token-by-token into one lump at the end.
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  });
  // Without this the first tokens sit in the kernel waiting for a full segment,
  // which is precisely the "phone shows nothing" failure this endpoint exists
  // to avoid.
  res.socket?.setNoDelay(true);
  res.flushHeaders?.();
}

function sseSend(res, event, data) {
  if (res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/* ------------------------------------------------------------------ *
 * Chat
 * ------------------------------------------------------------------ */

async function streamChat({ req, res, body, sendJson }) {
  /* ---- single-flight gate: refuse, never queue ---- */
  if (active) {
    const busy = busySnapshot();
    sendJson(res, 429, {
      error:
        `The local model is already answering (${busy.model}, ${Math.round(busy.elapsedMs / 1000)}s in). ` +
        'This Mac runs one generation at a time on purpose — wait for it to finish or stop it.',
      busy,
    });
    return;
  }

  /* ---- validate before claiming the slot ---- */
  let messages;
  try {
    messages = normaliseMessages(body.messages);
  } catch (err) {
    sendJson(res, 400, { error: err.message });
    return;
  }

  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : DEFAULT_MODEL;
  if (model.length > 200) {
    sendJson(res, 400, { error: 'model name is too long' });
    return;
  }

  const cwd = await resolveCwd(body.cwd ?? body.projectDir);
  const system = buildSystemPrompt({ cwd, presets: describeKinds() });

  /* ---- claim the slot ---- */
  const controller = new AbortController();
  const id = `gen_${++requestSeq}`;
  active = { id, model, startedAt: Date.now(), abort: () => controller.abort() };

  const watchdog = setTimeout(() => {
    log.warn(`assistant: ${id} exceeded ${GENERATION_TIMEOUT_MS}ms — aborting`);
    controller.abort();
  }, GENERATION_TIMEOUT_MS);

  // The phone locks, the tunnel drops, the user hits back: stop generating.
  // Holding the GPU for a reply nobody will read is the exact contention this
  // machine cannot afford.
  const onClientGone = () => controller.abort();
  res.on('close', onClientGone);

  let opened = false;
  const startedAt = Date.now();
  let firstTokenMs = null;
  let charCount = 0;

  try {
    // One model resident at a time. Unloading first is what keeps two ~5GB
    // sets of weights from ever overlapping in 16GB of shared memory.
    if (residentModel && residentModel !== model) {
      await unloadModel(residentModel);
      residentModel = null;
    }

    const upstream = await ollamaFetch('/api/chat', {
      method: 'POST',
      signal: controller.signal,
      body: {
        model,
        stream: true,
        keep_alive: KEEP_ALIVE,
        messages: [{ role: 'system', content: system }, ...messages],
        options: {
          num_ctx: NUM_CTX,
          num_predict: NUM_PREDICT,
          // Low but not zero: shell commands have a right answer, and creative
          // sampling here produces plausible flags that do not exist.
          temperature: 0.2,
          top_p: 0.9,
          repeat_penalty: 1.05,
        },
      },
    });

    if (!upstream.ok || !upstream.body) {
      const detail = summarize(await upstream.text().catch(() => ''), 300);
      // 404 from Ollama means the model name is not pulled — by far the most
      // likely cause, and a useful thing to say instead of "upstream error".
      const message = upstream.status === 404
        ? `Ollama has no model named "${model}". Pull it with \`ollama pull ${model}\` or pick another.`
        : `Ollama returned ${upstream.status}${detail ? `: ${detail}` : ''}`;
      sendJson(res, upstream.status === 404 ? 404 : 502, { error: message });
      return;
    }

    residentModel = model;
    openSse(res);
    opened = true;
    sseSend(res, 'start', { id, model, cwd });

    /* ---- Ollama streams newline-delimited JSON; forward it as SSE ---- */
    const decoder = new TextDecoder();
    let buffer = '';
    let finalChunk = null;

    for await (const chunk of upstream.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;

        let frame;
        try {
          frame = JSON.parse(line);
        } catch {
          continue; // a partial line; the next chunk completes it
        }

        if (frame.error) {
          sseSend(res, 'error', { error: String(frame.error) });
          return;
        }

        // Reasoning models put their monologue in `thinking` (or inline
        // <think> tags, which the client folds away). Forwarded separately so
        // the client can dim it instead of mixing it into the answer.
        const thinking = frame.message?.thinking;
        if (typeof thinking === 'string' && thinking) {
          sseSend(res, 'thinking', { text: thinking });
        }

        const text = frame.message?.content;
        if (typeof text === 'string' && text) {
          if (firstTokenMs === null) firstTokenMs = Date.now() - startedAt;
          charCount += text.length;
          sseSend(res, 'token', { text });
        }

        if (frame.done) finalChunk = frame;
      }
    }

    const ns = (v) => (typeof v === 'number' ? Math.round(v / 1e6) : null);
    const evalCount = finalChunk?.eval_count ?? null;
    const evalMs = ns(finalChunk?.eval_duration);
    sseSend(res, 'done', {
      id,
      model,
      firstTokenMs,
      totalMs: Date.now() - startedAt,
      loadMs: ns(finalChunk?.load_duration),
      promptEvalCount: finalChunk?.prompt_eval_count ?? null,
      promptEvalMs: ns(finalChunk?.prompt_eval_duration),
      evalCount,
      evalMs,
      tokensPerSecond: evalCount && evalMs ? Number((evalCount / (evalMs / 1000)).toFixed(1)) : null,
      chars: charCount,
      doneReason: finalChunk?.done_reason ?? null,
    });
  } catch (err) {
    const aborted = controller.signal.aborted;
    const message = aborted
      ? 'Generation stopped.'
      : err instanceof OllamaDown
        ? err.message
        : `Local model error: ${err.message}`;

    if (!opened) {
      // Nothing has been written yet, so a normal JSON error still works and
      // the client gets a real status code.
      if (!res.writableEnded) sendJson(res, err instanceof OllamaDown ? 503 : 500, { error: message });
    } else if (!aborted) {
      sseSend(res, 'error', { error: message });
    }
    if (!aborted) log.warn(`assistant: ${id} failed — ${err.message}`);
  } finally {
    clearTimeout(watchdog);
    res.off('close', onClientGone);
    if (active?.id === id) active = null;
    if (opened && !res.writableEnded) res.end();
  }
}

/* ------------------------------------------------------------------ *
 * Router
 * ------------------------------------------------------------------ */

/**
 * Handle everything under /api/assistant/. Returns false when the path is not
 * ours, so http-api.js can fall through to its own 404.
 *
 * Already behind checkAuth: http-api.js gates every /api/ path before routing.
 */
export async function handleAssistantApi({ req, res, url, pathname, method, readBody, sendJson }) {
  if (pathname !== '/api/assistant' && !pathname.startsWith('/api/assistant/')) return false;

  /* -------- what can answer, and is anything running -------- */
  if ((pathname === '/api/assistant/models' || pathname === '/api/assistant') && method === 'GET') {
    try {
      const models = await listModels();
      const names = new Set(models.map((m) => m.name));
      sendJson(res, 200, {
        ok: true,
        available: true,
        models,
        // Only claim the default if it is actually pulled, otherwise the client
        // would open pinned to a model that 404s on first send.
        default: names.has(DEFAULT_MODEL) ? DEFAULT_MODEL : models[0]?.name || null,
        preferred: DEFAULT_MODEL,
        endpoint: OLLAMA_URL,
        keepAlive: KEEP_ALIVE,
        busy: busySnapshot(),
      });
    } catch (err) {
      if (err instanceof OllamaDown) {
        // 503, not 500: the app is fine, the model server is not. The client
        // renders this as its own empty state and everything else keeps working.
        sendJson(res, 503, { ok: false, available: false, error: err.message, endpoint: OLLAMA_URL, models: [] });
        return true;
      }
      throw err;
    }
    return true;
  }

  if (pathname === '/api/assistant/status' && method === 'GET') {
    let available = true;
    let error = null;
    try {
      await listModels();
    } catch (err) {
      if (!(err instanceof OllamaDown)) throw err;
      available = false;
      error = err.message;
    }
    sendJson(res, 200, {
      ok: true,
      available,
      error,
      endpoint: OLLAMA_URL,
      busy: busySnapshot(),
      limits: { keepAlive: KEEP_ALIVE, numCtx: NUM_CTX, numPredict: NUM_PREDICT, singleFlight: true },
    });
    return true;
  }

  /* -------- stop whatever is generating -------- */
  if (pathname === '/api/assistant/stop' && method === 'POST') {
    const busy = busySnapshot();
    if (!active) {
      sendJson(res, 200, { ok: true, stopped: false, busy: null });
      return true;
    }
    active.abort();
    sendJson(res, 200, { ok: true, stopped: true, busy });
    return true;
  }

  /* -------- the chat stream -------- */
  if (pathname === '/api/assistant/chat' && method === 'POST') {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
      return true;
    }
    await streamChat({ req, res, body, sendJson });
    return true;
  }

  sendJson(res, 404, { error: 'no such endpoint' });
  return true;
}
