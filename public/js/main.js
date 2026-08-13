/**
 * Application entry point: boot, auth gate, routing, and the terminal view.
 *
 * Every view lives in index.html and is swapped by `show()`. Only one is ever
 * visible, so the terminal keeps its DOM (and therefore its scrollback and its
 * focus target) while another screen is up.
 *
 * ROUTES
 *   token             the auth gate, outside the tabbed shell
 *   sessions | usage  the two tabs inside `#shell`
 *   term              a full-screen terminal, outside the shell
 */

import {
  api, ApiError, hasToken, setToken, clearToken, verifyToken, pingServer,
} from './api.js';
import { applyServerKinds, getKind } from './kinds.js';
import { createSessionsView } from './views/sessions.js';
import { createTerminalsView } from './views/terminals.js';
import { createUsageView } from './views/usage.js';
import { createAssistantView } from './views/assistant.js';
import { createKeybar } from './keybar.js';
import {
  getSessionTerm, dropSessionTerm, disconnectAll, getFontSize, MAX_CACHED,
} from './session-term.js';
import { loadEnv, rememberCwd } from './env.js';
import { initPushMessaging, syncPush } from './push.js';
import { initViewport, onViewport } from './viewport.js';
import {
  h, clear, icon, toast, sheet, confirmSheet, prettyPath, projectName,
} from './ui.js';

/* ------------------------------------------------------------------ *
 * Element handles
 * ------------------------------------------------------------------ */

const views = {
  token: document.getElementById('view-token'),
  shell: document.getElementById('shell'),
  term: document.getElementById('view-term'),
};

/** The tabbed screens inside `#shell`, keyed by their `data-tab` value. */
const tabViews = {
  terminals: document.getElementById('view-terminals'),
  assistant: document.getElementById('view-assistant'),
  usage: document.getElementById('view-usage'),
};

const TAB_ICONS = { terminals: 'terminal', assistant: 'sparkle', usage: 'chart' };
const TAB_LABELS = { terminals: 'Terminals', assistant: 'Assistant', usage: 'Usage' };

const els = {
  tokenForm: document.getElementById('token-form'),
  tokenInput: document.getElementById('token-input'),
  tokenReveal: document.getElementById('token-reveal'),
  tokenError: document.getElementById('token-error'),
  tokenSubmit: document.getElementById('token-submit'),
  tokenHint: document.getElementById('token-hint'),

  termTitle: document.getElementById('term-title'),
  termPath: document.getElementById('term-path'),
  termKind: document.getElementById('term-kind'),
  termStage: document.getElementById('term-stage'),
  termMount: document.getElementById('term-mount'),
  termTabs: document.getElementById('term-tabs'),
  termBusy: document.getElementById('term-busy'),
  termBusySpin: document.getElementById('term-busy-spin'),
  termBusyTitle: document.getElementById('term-busy-title'),
  termBusyDesc: document.getElementById('term-busy-desc'),
  termBusyActions: document.getElementById('term-busy-actions'),
  jumpBottom: document.getElementById('jump-bottom'),
  keybar: document.getElementById('keybar'),
  conn: document.getElementById('conn'),
  connLabel: document.getElementById('conn-label'),
  btnBack: document.getElementById('btn-back'),
  btnTermMenu: document.getElementById('btn-term-menu'),
  tabbar: document.getElementById('tabbar'),
};

els.btnBack.append(icon('back'));
els.btnTermMenu.append(icon('more'));

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

let current = null;      // the session object currently shown in the term view
let term = null;         // its SessionTerm
let unsubscribe = [];    // listeners bound to the current SessionTerm
let route = 'token';
let lastTab = 'terminals'; // the tab to come back to when the terminal closes

/**
 * Terminals the user has open, least-recently-used first.
 *
 * Their sockets stay attached in the background — `detachCurrent()` only pulls
 * the xterm element out of the DOM — so switching is instant and no output is
 * missed. The cap matches the SessionTerm cache: a tab whose terminal had been
 * evicted would show an empty screen with no scrollback, which is worse than
 * not offering the tab at all.
 */
const openSessions = [];
const MAX_OPEN = MAX_CACHED;

/** dormant id -> the live session it was resumed into, so a re-tap reuses it. */
const resumedLive = new Map();

/** dormant id -> in-flight create request, so a double tap spawns one session. */
const resuming = new Map();

const sessionsView = createSessionsView({ onOpen: openSession });
const terminalsView = createTerminalsView();
const usageView = createUsageView();
// Same onOpen contract as the sessions view: the assistant's Run button creates a
// custom session and hands it back here to open. The model never executes anything.
const assistantView = createAssistantView({ onOpen: openSession });

const tabViewApis = { terminals: terminalsView, assistant: assistantView, usage: usageView };

const keybar = createKeybar(els.keybar, {
  send: (data) => term?.sendRaw(data),
  focus: () => term?.focus(),
  blur: () => term?.blur(),
  isFocused: () => Boolean(term?.isFocused()),
  getKind: () => current?.kind || 'claude',
  // The keybar grows a row when the pane controls open, which takes rows away
  // from the PTY. A stale geometry visibly corrupts a TUI, so re-fit on any
  // height change the bar makes.
  onLayout: () => refit(),
});

/* ------------------------------------------------------------------ *
 * Routing
 * ------------------------------------------------------------------ */

/**
 * Swap to a route. A tab route also shows the shell around it; `hide()` runs
 * on every tab we are leaving so background polling stops, and `show()` only on
 * the one arriving — which is what makes the usage scan lazy, paid for the
 * first time the user opens that tab rather than at boot.
 */
function show(name) {
  const isTab = Object.prototype.hasOwnProperty.call(tabViews, name);
  route = name;
  if (isTab) lastTab = name;

  views.token.hidden = name !== 'token';
  views.term.hidden = name !== 'term';
  views.shell.hidden = !isTab;

  for (const [key, el] of Object.entries(tabViews)) el.hidden = key !== name;
  for (const btn of els.tabbar.querySelectorAll('.tab')) {
    btn.classList.toggle('on', btn.dataset.tab === name);
    btn.setAttribute('aria-current', btn.dataset.tab === name ? 'page' : 'false');
  }

  for (const [key, view] of Object.entries(tabViewApis)) {
    if (key !== name) view.hide();
  }
  if (isTab) tabViewApis[name].show();
}

function showToken({ message } = {}) {
  disconnectAll();
  detachCurrent();
  openSessions.length = 0;
  resumedLive.clear();
  renderOpenTabs();
  show('token');
  els.tokenError.hidden = !message;
  if (message) els.tokenError.textContent = message;
  els.tokenInput.value = '';
  els.tokenHint.textContent = `Server: ${location.host}`;
  setTimeout(() => els.tokenInput.focus(), 120);
}

/** Back out of the terminal to whichever tab the user came from. */
function showList() {
  show(lastTab);
  if (history.state?.view === 'term') history.replaceState({ view: 'shell' }, '');
}

/* ------------------------------------------------------------------ *
 * Terminal view
 * ------------------------------------------------------------------ */

function detachCurrent() {
  for (const off of unsubscribe) off();
  unsubscribe = [];
  if (term) term.detach();
  term = null;
  current = null;
}

/** Only `live:<tmux-name>` addresses a process; everything else is on disk. */
function isLiveId(id) {
  return typeof id === 'string' && id.startsWith('live:');
}

/**
 * Open a row from any list.
 *
 * A dormant row is a transcript on disk, not a running process, and the
 * websocket only accepts live ids — so it is resumed into a real tmux session
 * first and the terminal attaches to the live id that call returns. Live rows
 * skip straight to the attach.
 */
async function openSession(session) {
  if (!session?.id) return;

  if (isLiveId(session.id)) {
    attachSession(session);
    return;
  }

  // Already resumed in this session of the app: re-tapping must reuse that
  // tmux session rather than spawning a second one against the same transcript.
  const known = resumedLive.get(session.id);
  if (known) {
    attachSession(known);
    return;
  }

  const live = await resumeSession(session);
  if (live) attachSession(live);
}

/**
 * Open a session named only by id — the notification deep link.
 *
 * The id arrives from outside the app (a tap on a lock-screen card, possibly
 * hours later), so the session may be in the list, may need fetching, or may
 * have ended in the meantime. All three end somewhere sensible rather than on a
 * blank terminal.
 */
async function openSessionById(id) {
  if (!id) return;

  const known = sessionsView.find(id);
  if (known) {
    openSession(known);
    return;
  }

  try {
    const session = await api.getSession(id);
    if (session) openSession(session);
    else toast('That session has already ended');
  } catch (err) {
    toast(err?.message || 'Could not open that session', { error: true });
  }
}

/**
 * Resume a dormant session and hand back its live row.
 *
 * The terminal view goes up first, showing progress: spawning a CLI (and a
 * model behind it) takes a moment, and a blank black rectangle for several
 * seconds is indistinguishable from a crash.
 */
async function resumeSession(session) {
  const kind = getKind(session.kind);

  detachCurrent();
  current = session;
  renderTermHeader();
  renderOpenTabs();
  keybar.syncKind();
  renderConn('connecting', 'resuming');
  show('term');
  showTermBusy({
    title: `Resuming ${kind.name}…`,
    desc: `${projectName(session)} · ${prettyPath(session.cwd) || session.id}`,
  });

  // Coalesce double taps onto one request. Two POSTs would produce two tmux
  // sessions resuming the same transcript, and the user would end up typing
  // into whichever one won the race.
  let pending = resuming.get(session.id);
  if (!pending) {
    pending = api.createSession({
      kind: session.kind,
      cwd: session.cwd || undefined,
      // The row's own resume handle where the server gave us one; the row id is
      // the documented fallback and the server parses it just as happily.
      resumeId: session.resumeId || session.id,
    });
    resuming.set(session.id, pending);
    const done = () => { if (resuming.get(session.id) === pending) resuming.delete(session.id); };
    pending.then(done, done);
  }

  let created;
  try {
    created = await pending;
  } catch (err) {
    // The server's own sentence — "Codex is not installed where claude-remote
    // looks for it…", "cwd is not an existing directory: …". A generic toast
    // here would throw away the only text that says what to do about it.
    showTermBusy({
      title: 'Could not resume this session',
      desc: err?.message || 'The server did not say why.',
      error: true,
      actions: [
        { label: 'Try again', primary: true, onClick: () => openSession(session) },
        { label: 'Back to sessions', onClick: () => { hideTermBusy(); showList(); } },
      ],
    });
    return null;
  }

  const live = created.session?.id ? created.session : {
    id: created.id,
    kind: session.kind,
    cwd: session.cwd,
    label: session.label,
    resumeId: session.resumeId,
    live: true,
  };

  resumedLive.set(session.id, live);
  // The list still shows this as resumable; it is a running process now.
  sessionsView.markResumed(session.id, live);
  return live;
}

function attachSession(session) {
  if (!session?.id) return;
  hideTermBusy();
  rememberCwd(session.cwd);
  noteOpen(session);

  if (current?.id === session.id && term) {
    // Same session re-opened (e.g. from the list after a refresh) — just show it.
    current = { ...current, ...session };
    renderTermHeader();
    renderOpenTabs();
    show('term');
    // A background tab may have been detached while it was off screen; connect()
    // is a no-op on a socket that is already up.
    term.connect();
    afterShowTerm();
    return;
  }

  detachCurrent();
  current = session;
  term = getSessionTerm(session.id);
  term.transform = keybar.transform;

  unsubscribe.push(term.on('state', ({ state, detail }) => renderConn(state, detail)));
  unsubscribe.push(term.on('scroll', ({ atBottom }) => {
    els.jumpBottom.hidden = atBottom;
  }));
  unsubscribe.push(term.on('gone', ({ id }) => {
    sessionsView.markGone(id);
    forgetLive(id);
    dropSessionTerm(id);
    toast('Session ended', { error: true });
  }));
  unsubscribe.push(term.on('detached', () => {
    toast('Detached — the session is still running');
  }));
  unsubscribe.push(term.on('geometry', ({ cols, rows }) => {
    toast(`Another viewer resized this session to ${cols}×${rows}`);
  }));
  unsubscribe.push(term.on('server-error', ({ message }) => {
    toast(message, { error: true });
  }));

  renderTermHeader();
  renderOpenTabs();
  keybar.syncKind();
  show('term');

  term.attach(els.termMount);
  term.connect();
  afterShowTerm();

  history.pushState({ view: 'term', id: session.id }, '');
}

function afterShowTerm() {
  refit();
  els.jumpBottom.hidden = term ? term.isAtBottom() : true;
}

/**
 * Re-measure the PTY against the current layout. Two passes: the first sizes
 * against the freshly-shown box, the second catches the safe-area/keybar
 * settling that iOS reports a frame late.
 */
function refit() {
  requestAnimationFrame(() => {
    term?.fit();
    setTimeout(() => term?.fit(), 180);
  });
}

/* ------------------------------------------------------------------ *
 * Resume progress
 * ------------------------------------------------------------------ */

function showTermBusy({ title, desc, error = false, actions = [] }) {
  els.termBusy.classList.toggle('err', error);
  els.termBusySpin.hidden = error;
  els.termBusyTitle.textContent = title;
  els.termBusyDesc.textContent = desc || '';
  clear(els.termBusyActions);
  for (const action of actions) {
    els.termBusyActions.append(h('button', {
      class: `btn${action.primary ? ' btn-primary' : ''}`,
      type: 'button',
      onClick: action.onClick,
    }, action.label));
  }
  els.termBusy.hidden = false;
}

function hideTermBusy() {
  els.termBusy.hidden = true;
  clear(els.termBusyActions);
}

/* ------------------------------------------------------------------ *
 * Open terminals
 * ------------------------------------------------------------------ */

/** Mark a session as open and most-recently-used, evicting the oldest tab. */
function noteOpen(session) {
  const idx = openSessions.findIndex((s) => s.id === session.id);
  const merged = idx >= 0 ? { ...openSessions[idx], ...session } : { ...session };
  if (idx >= 0) openSessions.splice(idx, 1);
  openSessions.push(merged);

  while (openSessions.length > MAX_OPEN) {
    const victim = openSessions.shift();
    // Dropping the terminal closes its websocket. tmux keeps the session, so
    // this is a detach: the work carries on and the row stays in the list.
    if (victim.id !== session.id) dropSessionTerm(victim.id);
  }
  renderOpenTabs();
}

/** Forget a live id everywhere the client tracks it. */
function forgetLive(id) {
  const idx = openSessions.findIndex((s) => s.id === id);
  if (idx >= 0) openSessions.splice(idx, 1);
  for (const [dormantId, live] of resumedLive) {
    if (live.id === id) resumedLive.delete(dormantId);
  }
  renderOpenTabs();
}

/**
 * Close a tab: detach this phone from the session without ending it. The tmux
 * session and whatever is running in it are untouched — that is the whole
 * point of the tmux layer, and a close button that killed work would be a trap.
 */
function closeOpenSession(id) {
  if (!openSessions.some((s) => s.id === id)) return;
  const wasCurrent = current?.id === id;

  if (wasCurrent) detachCurrent();
  forgetLive(id);
  dropSessionTerm(id);
  toast('Detached — the session is still running');

  if (!wasCurrent) return;

  const next = openSessions[openSessions.length - 1];
  if (next) attachSession(next);
  else showList();
}

function renderOpenTabs() {
  // The strip lives inside the terminal view, so it is invisible on every other
  // route without needing to know which one is up.
  const wanted = openSessions.length > 1;
  const heightChanged = els.termTabs.hidden === wanted;

  clear(els.termTabs);
  els.termTabs.hidden = !wanted;

  if (wanted) {
    // Most-recent last in the array, but reading order should be stable, so the
    // strip renders oldest-first and the active tab is scrolled into view.
    for (const s of openSessions) {
      const kind = getKind(s.kind);
      const on = current?.id === s.id;
      els.termTabs.append(h('div', {
        class: `ttab${on ? ' on' : ''}`,
        style: { '--k': kind.color },
      },
        h('button', {
          class: 'ttab-main',
          type: 'button',
          'aria-current': on ? 'true' : 'false',
          title: prettyPath(s.cwd) || s.id,
          onClick: () => openSession(s),
        },
          h('span', { class: 'ttab-dot' }),
          h('span', { class: 'ttab-name' }, projectName(s)),
        ),
        h('button', {
          class: 'ttab-x',
          type: 'button',
          'aria-label': `Close ${projectName(s)}`,
          onClick: () => closeOpenSession(s.id),
        }, icon('x', 14)),
      ));
    }
    els.termTabs.querySelector('.ttab.on')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  // Showing or hiding the strip changes how many rows the PTY has.
  if (heightChanged) refit();
}

function renderTermHeader() {
  if (!current) return;
  const kind = getKind(current.kind);
  els.termTitle.textContent = projectName(current);
  els.termPath.textContent = prettyPath(current.cwd) || current.id;
  clear(els.termKind);
  els.termKind.style.setProperty('--k', kind.color);
  els.termKind.textContent = kind.id;
  els.termKind.title = kind.name;
}

const CONN_LABEL = {
  idle: 'idle',
  connecting: 'connecting',
  reconnecting: 'reconnecting',
  open: 'live',
  closed: 'offline',
  detached: 'detached',
  error: 'error',
};

function renderConn(state, detail) {
  els.conn.dataset.state = state;
  let label = CONN_LABEL[state] || state;
  if (state === 'error' && detail) {
    label = detail === 'auth' ? 'auth' : detail === 'gone' ? 'ended' : detail === 'exited' ? 'exited' : 'error';
  }
  els.connLabel.textContent = label;
}

/* ------------------------------------------------------------------ *
 * Session menu
 * ------------------------------------------------------------------ */

function openTermMenu() {
  if (!current) return;
  const session = current;
  const kind = getKind(session.kind);

  sheet({
    title: projectName(session),
    build(body, close) {
      /* -------- font size -------- */
      const value = h('span', { class: 'stepper-val' }, `${getFontSize()}px`);
      const step = (delta) => {
        const next = term?.setFontSize(getFontSize() + delta);
        if (next) value.textContent = `${next}px`;
      };
      body.append(
        h('div', { class: 'sheet-field' },
          h('span', { class: 'field-label' }, 'Text size'),
          h('div', { class: 'stepper' },
            h('button', { type: 'button', 'aria-label': 'Smaller', onClick: () => step(-1) }, '−'),
            value,
            h('button', { type: 'button', 'aria-label': 'Larger', onClick: () => step(1) }, '+'),
          ),
        ),
      );

      body.append(menuRow('Redraw screen', 'Force the TUI to repaint', 'refresh', () => {
        close();
        term?.repaint();
      }));

      body.append(menuRow('Reconnect', 'Drop and re-open the stream', 'power', () => {
        close();
        term?.disconnect();
        term?.connect();
      }));

      body.append(menuRow('Leave running', 'Detach this phone; the session keeps going', 'logout', () => {
        close();
        term?.requestDetach();
        showList();
      }));

      if (openSessions.length > 1) {
        body.append(menuRow('Close this terminal', 'Drop the tab; the session keeps running', 'x', () => {
          close();
          closeOpenSession(session.id);
        }));
      }

      if (session.live) {
        body.append(menuRow('Kill session', `End the ${kind.name} process`, 'stop', async () => {
          close();
          const ok = await confirmSheet({
            title: 'Kill session',
            message: `End ${projectName(session)}? The ${kind.name} process and its tmux window are terminated.`,
            confirmLabel: 'Kill session',
            danger: true,
          });
          if (!ok) return;
          try {
            await api.killSession(session.id);
            dropSessionTerm(session.id);
            sessionsView.markGone(session.id);
            detachCurrent();
            forgetLive(session.id);
            const next = openSessions[openSessions.length - 1];
            if (next) attachSession(next);
            else showList();
            toast('Session killed');
          } catch (err) {
            toast(err.message || 'Could not kill session', { error: true });
          }
        }, true));
      }

      body.append(h('p', { class: 'sheet-note' },
        `${kind.name} · ${prettyPath(session.cwd) || session.id}`));
    },
  });
}

function menuRow(name, desc, iconName, onClick, danger = false) {
  return h('div', {
    class: `sheet-item${danger ? ' danger' : ''}`,
    role: 'button', tabindex: '0', onClick,
  },
    icon(iconName, 19),
    h('div', { class: 'sheet-item-main' },
      h('div', { class: 'sheet-item-name' }, name),
      h('div', { class: 'sheet-item-desc' }, desc),
    ),
  );
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

/* -------- tab bar -------- */

for (const btn of els.tabbar.querySelectorAll('.tab')) {
  const name = btn.dataset.tab;
  btn.append(icon(TAB_ICONS[name] || 'terminal', 20));
  btn.append(h('span', { class: 'tab-label' }, TAB_LABELS[name] || name));
  btn.addEventListener('click', () => {
    // Re-tapping the active tab is a refresh, the way it is everywhere else on
    // a phone; switching tabs is a plain swap.
    if (route === name) tabViewApis[name].reload?.();
    else show(name);
  });
}

els.btnBack.addEventListener('click', () => {
  if (history.state?.view === 'term') history.back();
  else showList();
});

els.btnTermMenu.addEventListener('click', openTermMenu);

els.jumpBottom.addEventListener('click', () => {
  term?.scrollToBottom();
  els.jumpBottom.hidden = true;
});

window.addEventListener('popstate', () => {
  if (route === 'token') return;
  if (history.state?.view === 'term' && current) show('term');
  else showList();
});

window.addEventListener('cr:unauthorized', () => {
  if (route === 'token') return;
  showToken({ message: 'That token was rejected. Paste the current one.' });
});

/* -------- notification taps -------- */

// The service worker focuses an already-open app rather than navigating it,
// which would discard every attached terminal — so it hands the session id over
// as a message instead of a URL.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type !== 'cr:open-session') return;
    if (route === 'token') return; // not signed in; the list is unreachable anyway
    openSessionById(event.data.sessionId);
  });
}

/**
 * A cold launch from a notification arrives as `?session=<id>`. It is stripped
 * from the URL immediately so a later reload — or an "Add to Home Screen" from
 * this state — does not keep reopening the same session forever.
 */
function takePendingSessionId() {
  const id = new URL(location.href).searchParams.get('session');
  if (!id) return null;
  history.replaceState(history.state, '', location.pathname);
  return id;
}

// The phone sleeps mid-session constantly; resume the stream the moment it wakes.
document.addEventListener('visibilitychange', () => {
  if (document.hidden || route !== 'term') return;
  term?.reconnectNow();
  requestAnimationFrame(() => term?.fit());
});

onViewport((_m, changed) => {
  if (changed && route === 'term') term?.fit();
});

/* -------- token form -------- */

els.tokenReveal.addEventListener('click', () => {
  const hidden = els.tokenInput.type === 'password';
  els.tokenInput.type = hidden ? 'text' : 'password';
  els.tokenReveal.textContent = hidden ? 'hide' : 'show';
  els.tokenReveal.setAttribute('aria-label', hidden ? 'Hide token' : 'Show token');
});

els.tokenForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const candidate = els.tokenInput.value.trim();
  if (!candidate) return;

  els.tokenSubmit.disabled = true;
  els.tokenSubmit.textContent = 'Connecting…';
  els.tokenError.hidden = true;

  try {
    await verifyToken(candidate);
    setToken(candidate);
    els.tokenInput.value = '';
    await Promise.all([loadKinds(), loadEnv()]);
    showList();
  } catch (err) {
    const message = err instanceof ApiError && err.isAuth
      ? 'That token is not valid on this server.'
      : (err.message || 'Could not reach the server.');
    els.tokenError.textContent = message;
    els.tokenError.hidden = false;
  } finally {
    els.tokenSubmit.disabled = false;
    els.tokenSubmit.textContent = 'Connect';
  }
});

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

async function loadKinds() {
  try {
    const kinds = await api.listKinds();
    if (kinds) applyServerKinds(kinds);
  } catch {
    /* keep the built-in registry */
  }
}

/**
 * `?token=…` in the URL logs you straight in.
 *
 * This is how the setup instructions get the token onto a phone: the link is
 * mailed or messaged to yourself and opened once. The value is moved into
 * storage and then stripped from the address bar with replaceState, so the
 * secret does not sit in the tab title, the back stack, or whatever the browser
 * later syncs or offers to autocomplete.
 */
function takeTokenFromUrl() {
  let url;
  try { url = new URL(location.href); } catch { return; }
  const candidate = url.searchParams.get('token');
  if (!candidate) return;

  url.searchParams.delete('token');
  history.replaceState(history.state, '', url.pathname + url.search + url.hash);

  const trimmed = candidate.trim();
  if (trimmed) setToken(trimmed);
}

async function boot() {
  initViewport();
  registerServiceWorker();
  initPushMessaging();

  takeTokenFromUrl();
  const pendingSessionId = takePendingSessionId();

  if (!hasToken()) {
    showToken();
    return;
  }

  try {
    await api.health({ timeout: 8000 });
  } catch (err) {
    if (err instanceof ApiError && err.isAuth) {
      clearToken();
      showToken({ message: 'The stored token is no longer valid.' });
      return;
    }
    // Unreachable rather than unauthorised: a sleeping Mac must not throw away
    // a perfectly good token and make the user hunt for it again.
    const reachable = await pingServer();
    if (!reachable) {
      showList(); // the list renders its own "cannot reach the server" state
      return;
    }
  }

  await Promise.all([loadKinds(), loadEnv()]);
  showList();

  // Re-register the push subscription this browser already holds. The only
  // thing that repairs one iOS has expired, and a no-op otherwise.
  syncPush().catch(() => {});

  if (pendingSessionId) openSessionById(pendingSessionId);
}

/**
 * The service worker only caches the app shell. It requires a secure context,
 * which plain http:// to a Tailscale IP is not — so registration is skipped
 * rather than failed noisily. Front the server with `tailscale serve` (HTTPS)
 * to get offline caching and Android installability.
 */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {
      /* caching is an optimisation; never block the app on it */
    });
  });
}

boot();
