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
import { createUsageView } from './views/usage.js';
import { createAssistantView } from './views/assistant.js';
import { createKeybar } from './keybar.js';
import {
  getSessionTerm, dropSessionTerm, disconnectAll, getFontSize,
} from './session-term.js';
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
  sessions: document.getElementById('view-sessions'),
  assistant: document.getElementById('view-assistant'),
  usage: document.getElementById('view-usage'),
};

const TAB_ICONS = { sessions: 'terminal', assistant: 'sparkle', usage: 'chart' };
const TAB_LABELS = { sessions: 'Sessions', assistant: 'Assistant', usage: 'Usage' };

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
let lastTab = 'sessions'; // the tab to come back to when the terminal closes

const sessionsView = createSessionsView({ onOpen: openSession });
const usageView = createUsageView();
// Same onOpen contract as the sessions view: the assistant's Run button creates a
// custom session and hands it back here to open. The model never executes anything.
const assistantView = createAssistantView({ onOpen: openSession });

const tabViewApis = { sessions: sessionsView, assistant: assistantView, usage: usageView };

const keybar = createKeybar(els.keybar, {
  send: (data) => term?.sendRaw(data),
  focus: () => term?.focus(),
  blur: () => term?.blur(),
  isFocused: () => Boolean(term?.isFocused()),
  getKind: () => current?.kind || 'claude',
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

function openSession(session) {
  if (!session?.id) return;

  if (current?.id === session.id && term) {
    // Same session re-opened (e.g. from the list after a refresh) — just show it.
    current = { ...current, ...session };
    renderTermHeader();
    show('term');
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
  keybar.syncKind();
  show('term');

  term.attach(els.termMount);
  term.connect();
  afterShowTerm();

  history.pushState({ view: 'term', id: session.id }, '');
}

function afterShowTerm() {
  // Two passes: the first sizes against the freshly-shown box, the second
  // catches the safe-area/keybar settling that iOS reports a frame late.
  requestAnimationFrame(() => {
    term?.fit();
    setTimeout(() => term?.fit(), 180);
  });
  els.jumpBottom.hidden = term ? term.isAtBottom() : true;
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
            showList();
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
    await loadKinds();
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

async function boot() {
  initViewport();
  registerServiceWorker();

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

  await loadKinds();
  showList();
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
