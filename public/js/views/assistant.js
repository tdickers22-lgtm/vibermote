/**
 * Assistant — a small model running on the Mac itself that writes the commands
 * so the phone does not have to.
 *
 * THE POINT OF THIS SCREEN: typing `find . -type f -size +100M -mtime -7` on a
 * phone keyboard is miserable, and getting one character wrong is worse. So the
 * user says what they want in English, the local model writes the command, and
 * it lands in a card with a Run button. One tap replaces forty keystrokes.
 *
 * ┌─ THE MODEL NEVER RUNS ANYTHING ─────────────────────────────────────────┐
 * │ Every command in this thread is inert text until the human taps Run.    │
 * │ Run is the only path from model output to a shell, it is always an      │
 * │ explicit tap on a command the user can read in full, and it goes        │
 * │ through the ordinary `POST /api/sessions {command}` route — the same    │
 * │ one the user's own typed commands use. There is no auto-run, no         │
 * │ "execute and show me the output" affordance, and none may be added:     │
 * │ a 7B model will eventually suggest something destructive, and the only  │
 * │ thing that makes that harmless is a human reading it first.             │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Streaming: the reply arrives over SSE (see server/assistant.js for why not
 * the websocket) and is read with `fetch` + a stream reader rather than
 * EventSource, because EventSource cannot set an Authorization header and the
 * token must never be put in a URL. A 7B model on an M1 needs a few seconds
 * warm and ~15 with a cold load, so tokens are painted as they arrive; a screen
 * that sat blank that long would read as broken.
 */

import { getToken, normaliseSession, api } from '../api.js';
import { h, clear, icon, toast, sheet, prettyPath } from '../ui.js';

const MODEL_KEY = 'claude-remote:assistant-model';
const CWD_KEY = 'claude-remote:assistant-cwd';

/** Matches the server's own default; used until /api/assistant/models answers. */
const FALLBACK_MODEL = 'qwen2.5:7b';

/** Sent to the model as history. The server trims again; this keeps the wire small. */
const MAX_HISTORY = 12;

const STARTERS = [
  'Find every file over 100MB modified in the last week',
  'What is listening on port 8787?',
  'Show me the 10 biggest folders in this directory',
  'Tail the last 50 lines of every .log file here',
];

export function createAssistantView({ onOpen }) {
  const thread = document.getElementById('ai-thread');
  const scroll = document.getElementById('ai-scroll');
  const form = document.getElementById('ai-composer');
  const input = document.getElementById('ai-input');
  const sendBtn = document.getElementById('ai-send');
  const contextBtn = document.getElementById('ai-context');
  const btnNew = document.getElementById('btn-ai-new');

  /** @type {{role:string, content:string, model?:string, stats?:object, thinking?:string, error?:boolean}[]} */
  let messages = [];
  let models = [];
  let model = readStored(MODEL_KEY) || FALLBACK_MODEL;
  let cwd = readStored(CWD_KEY) || '';
  let projects = [];
  let ollama = { checked: false, available: false, error: null };
  let streaming = null;     // { controller, node, message }
  let stickToBottom = true;
  let visible = false;

  btnNew.append(icon('plus'));
  sendBtn.append(icon('arrowUp', 20));

  /* ------------------------------------------------------------ discovery */

  /**
   * Ask the server what can answer. Never throws outward: Ollama being stopped
   * is a state this screen renders, not an error that breaks the app.
   */
  async function loadModels({ quiet = false } = {}) {
    try {
      const payload = await fetchJson('/api/assistant/models');
      models = Array.isArray(payload.models) ? payload.models : [];
      ollama = { checked: true, available: true, error: null };
      // Pin to a model that actually exists — a stored name for a model the
      // user has since removed would 404 on the first send.
      if (!models.some((m) => m.name === model)) {
        model = payload.default || models[0]?.name || FALLBACK_MODEL;
        store(MODEL_KEY, model);
      }
    } catch (err) {
      models = [];
      ollama = { checked: true, available: false, error: err.message };
      if (!quiet) render();
    }
    renderContext();
    render();
  }

  async function loadProjects() {
    try {
      projects = await api.listProjects();
      if (!cwd && projects.length) {
        cwd = projects[0].cwd;
        store(CWD_KEY, cwd);
        renderContext();
      }
    } catch { /* the picker just has fewer suggestions */ }
  }

  /* -------------------------------------------------------------- sending */

  async function send(text) {
    const prompt = text.trim();
    if (!prompt || streaming) return;

    messages.push({ role: 'user', content: prompt });
    input.value = '';
    autoGrow();
    stickToBottom = true;

    const reply = { role: 'assistant', content: '', thinking: '', model, pending: true };
    messages.push(reply);
    render();

    const controller = new AbortController();
    streaming = { controller, message: reply };
    renderComposer();

    try {
      const res = await fetch('/api/assistant/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
        },
        body: JSON.stringify({
          model,
          cwd: cwd || undefined,
          messages: messages
            .filter((m) => !m.error && (m.role === 'user' || m.content))
            .slice(-MAX_HISTORY)
            .map((m) => ({ role: m.role, content: m.content })),
        }),
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'omit',
      });

      if (!res.ok || !res.body) {
        if (res.status === 401 || res.status === 403) {
          window.dispatchEvent(new CustomEvent('cr:unauthorized'));
          return;
        }
        const payload = await res.json().catch(() => null);
        throw new Error(payload?.error || `The assistant failed (${res.status})`);
      }

      await consume(res.body, reply);
    } catch (err) {
      if (err?.name === 'AbortError') {
        reply.stopped = true;
        if (!reply.content) reply.content = '_Stopped._';
      } else {
        reply.error = true;
        reply.content = err.message || 'The assistant failed.';
        // A dead Ollama discovered mid-send should flip the whole screen's
        // state, not just leave one red bubble behind.
        if (/model server is answering|Ollama/i.test(reply.content)) {
          ollama = { checked: true, available: false, error: reply.content };
        }
      }
    } finally {
      reply.pending = false;
      streaming = null;
      renderComposer();
      render();
    }
  }

  /** Read the SSE stream and paint tokens as they land. */
  async function consume(body, reply) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let painting = false;

    // Repainting on every token would run a parse + DOM rebuild per character.
    // One paint per frame keeps it smooth on a phone.
    const paint = () => {
      if (painting) return;
      painting = true;
      requestAnimationFrame(() => {
        painting = false;
        renderStreaming(reply);
      });
    };

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let split;
      while ((split = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);

        let event = null;
        let data = null;
        for (const line of frame.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7).trim();
          else if (line.startsWith('data: ')) {
            try { data = JSON.parse(line.slice(6)); } catch { data = null; }
          }
        }
        if (!event || !data) continue;

        if (event === 'token') { reply.content += data.text; paint(); }
        else if (event === 'thinking') { reply.thinking += data.text; paint(); }
        else if (event === 'start') { reply.model = data.model || reply.model; reply.cwd = data.cwd; }
        else if (event === 'done') { reply.stats = data; reply.model = data.model || reply.model; }
        else if (event === 'error') { reply.error = true; reply.content = data.error; }
      }
    }
  }

  function stop() {
    streaming?.controller.abort();
  }

  /* ------------------------------------------------------------ rendering */

  function render() {
    clear(thread);

    if (ollama.checked && !ollama.available && !messages.length) {
      thread.append(offlineState());
      renderComposer();
      return;
    }

    if (!messages.length) {
      thread.append(emptyState());
      renderComposer();
      return;
    }

    for (const message of messages) thread.append(bubble(message));
    renderComposer();
    if (stickToBottom) scrollToBottom();
  }

  /** Repaint only the streaming bubble — the rest of the thread is unchanged. */
  function renderStreaming(reply) {
    const node = thread.querySelector('[data-streaming="1"]');
    const fresh = bubble(reply);
    if (node) node.replaceWith(fresh);
    else thread.append(fresh);
    if (stickToBottom) scrollToBottom();
  }

  function bubble(message) {
    if (message.role === 'user') {
      return h('div', { class: 'ai-msg ai-user' }, h('div', { class: 'ai-bubble' }, message.content));
    }

    const wrap = h('div', {
      class: `ai-msg ai-bot${message.error ? ' ai-err' : ''}`,
      dataset: message.pending ? { streaming: '1' } : {},
    });

    const { thinking, segments } = parseReply(message.content);

    if (message.thinking || thinking) {
      wrap.append(thinkingBlock(message.thinking || thinking));
    }

    for (const seg of segments) {
      if (seg.type === 'code') wrap.append(commandCard(seg, message));
      else if (seg.value.trim()) wrap.append(h('div', { class: 'ai-bubble' }, seg.value.trim()));
    }

    if (message.pending && !segments.some((s) => s.value.trim())) {
      wrap.append(h('div', { class: 'ai-bubble ai-waiting' },
        h('span', { class: 'ai-dots' }, h('i'), h('i'), h('i')),
        h('span', { class: 'ai-waiting-text' }, `${message.model} is thinking…`),
      ));
    }

    wrap.append(metaLine(message));
    return wrap;
  }

  /**
   * The command card — the reason this screen exists.
   *
   * Run posts the command to POST /api/sessions as a `custom` session and opens
   * the terminal on it. The command is shown in full, above the button, with
   * the directory it will run in: the user's tap is the authorisation, so what
   * they are authorising has to be legible first.
   */
  function commandCard(seg, message) {
    const command = seg.value.trim();
    const ready = seg.closed && !message.pending && Boolean(command);

    const run = h('button', {
      class: 'cmd-btn cmd-run', type: 'button',
      disabled: !ready || null,
      onClick: () => runCommand(command, run),
    }, icon('play', 16), 'Run');

    const copy = h('button', {
      class: 'cmd-btn', type: 'button',
      disabled: !ready || null,
      onClick: () => {
        copyText(command);
        copy.classList.add('ok');
        setTimeout(() => copy.classList.remove('ok'), 1200);
      },
    }, icon('clipboard', 16), 'Copy');

    return h('div', { class: `cmd${ready ? '' : ' cmd-partial'}` },
      h('div', { class: 'cmd-head' },
        h('span', { class: 'cmd-lang' }, seg.lang || 'sh'),
        h('span', { class: 'cmd-cwd' }, prettyPath(cwd) || '~'),
      ),
      h('pre', { class: 'cmd-body' }, h('code', null, command)),
      h('div', { class: 'cmd-actions' }, run, copy),
    );
  }

  async function runCommand(command, button) {
    const label = button.textContent;
    button.disabled = true;
    button.textContent = 'Starting…';
    try {
      // The ONLY place a model-written string reaches the machine, and it goes
      // through the same endpoint as a hand-typed command — no privileged path.
      const payload = await fetchJson('/api/sessions', {
        method: 'POST',
        body: { command, projectDir: cwd || undefined, label: shortLabel(command) },
      });
      const session = normaliseSession(payload.session)
        || { id: payload.id, cwd: payload.cwd || cwd, kind: 'custom', live: true, label: shortLabel(command) };
      onOpen(session);
    } catch (err) {
      toast(err.message || 'Could not start that command', { error: true });
      button.disabled = false;
      clear(button);
      button.append(icon('play', 16), 'Run');
      button.textContent = label;
    }
  }

  function thinkingBlock(text) {
    const body = h('div', { class: 'ai-think-body' }, text.trim());
    body.hidden = true;
    const toggle = h('button', { class: 'ai-think-toggle', type: 'button' }, 'Show reasoning');
    toggle.addEventListener('click', () => {
      body.hidden = !body.hidden;
      toggle.textContent = body.hidden ? 'Show reasoning' : 'Hide reasoning';
    });
    return h('div', { class: 'ai-think' }, toggle, body);
  }

  /** Which model answered, and what it cost in time. */
  function metaLine(message) {
    const bits = [message.model];
    const s = message.stats;
    if (s) {
      if (s.firstTokenMs != null) bits.push(`${fmtSecs(s.firstTokenMs)} to first token`);
      if (s.totalMs != null) bits.push(`${fmtSecs(s.totalMs)} total`);
      if (s.tokensPerSecond) bits.push(`${s.tokensPerSecond} tok/s`);
    } else if (message.pending) {
      bits.push('streaming…');
    }
    return h('div', { class: 'ai-meta' }, bits.filter(Boolean).join(' · '));
  }

  function emptyState() {
    const wrap = h('div', { class: 'ai-empty' },
      h('p', { class: 'ai-empty-title' }, 'Describe it, tap Run'),
      h('p', { class: 'ai-empty-sub' },
        `${model} runs on this Mac and writes the shell command for you. `
        + 'Nothing runs until you tap Run.'),
    );
    const chips = h('div', { class: 'ai-starters' });
    for (const s of STARTERS) {
      chips.append(h('button', {
        class: 'ai-starter', type: 'button',
        onClick: () => { input.value = s; autoGrow(); input.focus(); },
      }, s));
    }
    wrap.append(chips);
    return wrap;
  }

  function offlineState() {
    return h('div', { class: 'state' },
      h('p', { class: 'state-title' }, 'The local model is not running'),
      h('p', { class: 'state-sub' }, ollama.error || 'Ollama did not answer.'),
      h('button', { class: 'btn btn-primary', onClick: () => loadModels() }, 'Try again'),
    );
  }

  function renderContext() {
    clear(contextBtn);
    contextBtn.append(
      h('span', { class: 'ai-ctx-model' }, model),
      h('span', { class: 'ai-ctx-sep' }, '·'),
      h('span', { class: 'ai-ctx-cwd' }, prettyPath(cwd) || 'home directory'),
      h('span', { class: 'ai-ctx-caret' }, '▾'),
    );
  }

  function renderComposer() {
    const busy = Boolean(streaming);
    input.disabled = false;
    sendBtn.classList.toggle('stop', busy);
    sendBtn.setAttribute('aria-label', busy ? 'Stop generating' : 'Send');
    clear(sendBtn);
    sendBtn.append(icon(busy ? 'stop' : 'arrowUp', busy ? 16 : 20));
    sendBtn.disabled = !busy && !input.value.trim();
  }

  function scrollToBottom() {
    scroll.scrollTop = scroll.scrollHeight;
  }

  /* -------------------------------------------------------------- pickers */

  function openSettings() {
    sheet({
      title: 'Assistant',
      build(body, close) {
        /* -------- model -------- */
        body.append(h('span', { class: 'field-label' }, 'Model'));
        if (!models.length) {
          body.append(h('p', { class: 'sheet-note' },
            ollama.available === false
              ? (ollama.error || 'Ollama is not answering.')
              : 'No models reported yet.'));
        }
        for (const m of models) {
          const on = m.name === model;
          body.append(h('div', {
            class: `sheet-item${on ? ' on' : ''}`, role: 'button', tabindex: '0',
            onClick: () => {
              model = m.name;
              store(MODEL_KEY, model);
              renderContext();
              render();
              close();
            },
          },
            h('div', { class: 'sheet-item-main' },
              h('div', { class: 'sheet-item-name' }, m.name),
              h('div', { class: 'sheet-item-desc' }, [
                m.parameterSize,
                m.quantization,
                m.sizeBytes ? `${(m.sizeBytes / 1e9).toFixed(1)}GB` : null,
                m.thinking ? 'reasoning model' : null,
                m.name === FALLBACK_MODEL ? 'recommended for shell' : null,
              ].filter(Boolean).join(' · ')),
            ),
            on ? h('span', { class: 'sheet-tick' }, '✓') : null,
          ));
        }

        /* -------- working directory -------- */
        const cwdInput = h('input', {
          class: 'text-input',
          type: 'text',
          value: cwd,
          placeholder: 'Home directory',
          autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false',
        });
        const chips = h('div', { class: 'chips' });
        for (const p of projects.slice(0, 8)) {
          chips.append(h('button', {
            class: 'chip', type: 'button',
            onClick: () => { cwdInput.value = p.cwd; },
          }, prettyPath(p.cwd)));
        }

        body.append(
          h('div', { class: 'sheet-field', style: { marginTop: '16px' } },
            h('span', { class: 'field-label' }, 'Working directory'),
            cwdInput,
            projects.length ? chips : null,
            h('p', { class: 'sheet-note' },
              'Told to the model so it writes commands that fit this folder, and used '
              + 'as the directory anything you Run starts in.'),
          ),
          h('button', {
            class: 'btn btn-primary',
            onClick: () => {
              cwd = cwdInput.value.trim();
              store(CWD_KEY, cwd);
              renderContext();
              render();
              close();
            },
          }, 'Save'),
        );
      },
    });
  }

  /* --------------------------------------------------------------- wiring */

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (streaming) stop();
    else send(input.value);
  });

  input.addEventListener('input', () => { autoGrow(); renderComposer(); });

  input.addEventListener('keydown', (ev) => {
    // Enter sends; the phone keyboard's return key is labelled "send" to match.
    // Shift+Enter still makes a newline for anyone on a real keyboard.
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      if (!streaming) send(input.value);
    }
  });

  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
  }

  scroll.addEventListener('scroll', () => {
    const slack = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
    stickToBottom = slack < 60;
  });

  contextBtn.addEventListener('click', openSettings);

  btnNew.addEventListener('click', () => {
    if (streaming) stop();
    messages = [];
    render();
    input.focus();
  });

  renderContext();
  renderComposer();

  return {
    show() {
      visible = true;
      render();
      // Deliberately lazy: nothing here is fetched, and no model is loaded,
      // until the user actually opens this tab.
      if (!ollama.checked) loadModels({ quiet: true });
      if (!projects.length) loadProjects();
      scrollToBottom();
    },
    hide() {
      visible = false;
      // Leaving the tab should not leave the GPU busy on a fanless machine.
      if (streaming) stop();
    },
    reload: () => (visible ? loadModels() : undefined),
  };
}

/* ------------------------------------------------------------------ *
 * Reply parsing
 * ------------------------------------------------------------------ */

/**
 * Split a (possibly still-streaming) reply into prose and fenced code blocks.
 *
 * The last fence may well be unterminated mid-stream; that segment comes back
 * with `closed: false` so the card can render the partial command while keeping
 * Run disabled. Offering Run on half a command is how you delete half a
 * directory.
 */
export function parseReply(raw) {
  const text = String(raw || '');

  // Reasoning models emit <think>…</think> inline. Pull it out so it can be
  // folded away rather than shown where the answer should be.
  let thinking = '';
  let body = text.replace(/<think>([\s\S]*?)<\/think>/gi, (_m, inner) => {
    thinking += inner;
    return '';
  });
  // An unterminated <think> while streaming: everything after it is reasoning.
  const openThink = body.indexOf('<think>');
  if (openThink !== -1) {
    thinking += body.slice(openThink + 7);
    body = body.slice(0, openThink);
  }

  const segments = [];
  const fence = /```([A-Za-z0-9_+-]*)[ \t]*\n?/g;
  let cursor = 0;
  let match;

  while ((match = fence.exec(body)) !== null) {
    segments.push({ type: 'text', value: body.slice(cursor, match.index) });

    const lang = normaliseLang(match[1]);
    const start = match.index + match[0].length;
    const end = body.indexOf('```', start);

    if (end === -1) {
      segments.push({ type: 'code', lang, value: body.slice(start), closed: false });
      cursor = body.length;
      break;
    }

    segments.push({ type: 'code', lang, value: body.slice(start, end), closed: true });
    cursor = end + 3;
    fence.lastIndex = cursor;
  }

  if (cursor < body.length) segments.push({ type: 'text', value: body.slice(cursor) });
  return { thinking, segments };
}

function normaliseLang(lang) {
  const l = String(lang || '').toLowerCase();
  if (!l) return 'sh';
  if (l === 'shell' || l === 'console' || l === 'zsh' || l === 'bash' || l === 'sh') return 'sh';
  return l;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

async function fetchJson(path, { method = 'GET', body } = {}) {
  const token = getToken();
  const res = await fetch(path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
    credentials: 'omit',
  });

  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      window.dispatchEvent(new CustomEvent('cr:unauthorized'));
    }
    throw new Error(payload?.error || `Request failed (${res.status})`);
  }
  return payload || {};
}

/**
 * Copy without assuming a secure context: reaching the Mac over plain http at a
 * Tailscale IP leaves `navigator.clipboard` undefined, which is exactly the
 * setup this app ships in, so the execCommand path is the normal one here
 * rather than a legacy fallback.
 */
function copyText(text) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(
      () => toast('Command copied'),
      () => legacyCopy(text),
    );
    return;
  }
  legacyCopy(text);
}

function legacyCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  document.body.append(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  toast(ok ? 'Command copied' : 'Could not copy — select the text instead', { error: !ok });
}

function shortLabel(command) {
  const flat = command.replace(/\s+/g, ' ').trim();
  return flat.length > 32 ? `${flat.slice(0, 31)}…` : flat;
}

function fmtSecs(ms) {
  const n = Number(ms) || 0;
  return n < 1000 ? `${Math.round(n)}ms` : `${(n / 1000).toFixed(1)}s`;
}

function readStored(key) {
  try { return localStorage.getItem(key) || ''; } catch { return ''; }
}

function store(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch { /* private mode — the choice just does not persist */ }
}
