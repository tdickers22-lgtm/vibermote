/**
 * Terminals — your Mac's Terminal windows, live, and typeable.
 *
 * This is not the session list. The session list is Vibermote's own tmux
 * sessions plus every dormant transcript it can reconstruct, which is a
 * catalogue. This answers one question: what is on the Mac's screen right
 * now, and can I drive it? So it shows only real, currently-open Terminal
 * windows, drawn as the windows they are, in the same order termtile tiles them
 * on the Mac — project first, then CLI, with a project's shells trailing.
 *
 * Typing works by focusing the window on the Mac and sending real keystrokes
 * (see scripts/terminal-input.js), so the agent running in it receives them
 * exactly as if they had been typed at the keyboard.
 */
import { api, ApiError, clearToken } from '../api.js';
import { h, icon, sheet, confirmSheet, toast } from '../ui.js';
import { openPushSheet, pushMenuRow } from '../push.js';

const POLL_MS = 4000;
/** While a window is open, poll fast enough to watch it respond. */
const POLL_MS_ZOOM = 1200;
/** Lines of the screen a card shows. The bottom is the part that matters. */
const CARD_LINES = 14;

/** The keys a TUI needs that a phone keyboard cannot send. */
const KEYS = [
  ['esc', 'escape'], ['↑', 'up'], ['↓', 'down'], ['⇥', 'tab'],
  ['^C', 'ctrl+c'], ['^D', 'ctrl+d'], ['^O', 'ctrl+o'], ['⏎', 'enter'],
];

export function createTerminalsView() {
  const body = document.getElementById('terminals-body');
  const countEl = document.getElementById('terminals-count');
  const btnRefresh = document.getElementById('btn-terminals-refresh');
  const btnNew = document.getElementById('btn-terminals-new');
  const btnMenu = document.getElementById('btn-terminals-menu');

  let windows = [];
  let visible = false;
  let timer = 0;
  let inFlight = false;
  let loadedOnce = false;
  let zoomedId = null;
  let sending = false;

  /* --------------------------------------------------------------- loading */

  async function load({ quiet = false } = {}) {
    if (inFlight) return;
    inFlight = true;
    if (!quiet) btnRefresh?.classList.add('spinning');
    try {
      windows = await api.listTerminalWindows();
      loadedOnce = true;
      render();
    } catch (err) {
      if (err instanceof ApiError && err.isAuth) return;   // main.js handles the bounce
      if (!quiet) toast(err.message || 'Could not read Terminal windows', { error: true });
      if (!loadedOnce) renderMessage('Could not reach the Mac.');
    } finally {
      inFlight = false;
      btnRefresh?.classList.remove('spinning');
    }
  }

  function schedulePoll() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (visible && !document.hidden) await load({ quiet: true });
      if (visible) schedulePoll();
    }, zoomedId ? POLL_MS_ZOOM : POLL_MS);
  }

  /* -------------------------------------------------------------- render */

  function renderMessage(text) {
    body.textContent = '';
    const p = document.createElement('p');
    p.className = 'terminals-empty';
    p.textContent = text;
    body.append(p);
  }

  /** Last N lines, which is what a card has room for. */
  function tail(screen, n) {
    const lines = String(screen || '').replace(/\s+$/, '').split('\n');
    return lines.slice(Math.max(0, lines.length - n)).join('\n');
  }

  function titleBar(w, { withClose = false } = {}) {
    const bar = document.createElement('header');
    bar.className = 'twin-bar';
    const dots = document.createElement('span');
    dots.className = 'twin-dots';
    for (let i = 0; i < 3; i++) dots.append(document.createElement('i'));
    const title = document.createElement('span');
    title.className = 'twin-title';
    title.textContent = (withClose ? w.title : w.label) || w.label || 'Terminal';
    bar.append(dots, title);
    if (withClose) {
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'twin-zoom-close';
      close.textContent = 'Done';
      close.addEventListener('click', (e) => { e.stopPropagation(); closeZoom(); });
      bar.append(close);
    } else if (w.minimized) {
      const badge = document.createElement('span');
      badge.className = 'twin-badge';
      badge.textContent = 'minimised';
      bar.append(badge);
    }
    return bar;
  }

  function card(w) {
    const el = document.createElement('article');
    el.className = 'twin';
    if (w.minimized) el.classList.add('twin-min');
    el.dataset.id = w.id;
    const screen = document.createElement('pre');
    screen.className = 'twin-screen';
    screen.textContent = tail(w.screen, CARD_LINES) || '(nothing on screen)';
    el.append(titleBar(w), screen);
    el.addEventListener('click', () => zoom(w.id));
    return el;
  }

  function render() {
    if (!windows.length) {
      if (countEl) countEl.textContent = '';
      renderMessage(loadedOnce ? 'No Terminal windows are open on the Mac.' : 'Loading…');
      return;
    }
    if (countEl) countEl.textContent = ` ${windows.length}`;
    body.textContent = '';

    let lastGroup = null;
    for (const w of windows) {
      if (w.group !== lastGroup) {
        lastGroup = w.group;
        const h = document.createElement('h2');
        h.className = 'twin-group';
        h.textContent = w.group;
        body.append(h);
      }
      body.append(card(w));
    }

    if (zoomedId) {
      const still = windows.find((w) => w.id === zoomedId);
      if (still) paintZoom(still);
      else closeZoom();
    }
  }

  /* ---------------------------------------------------------------- zoom */

  function zoomEl() {
    let el = document.getElementById('terminals-zoom');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'terminals-zoom';
    el.className = 'twin-zoom';
    el.hidden = true;
    // Tapping the backdrop closes. The window itself stops propagation so
    // typing in it never dismisses the thing you are typing into.
    el.addEventListener('click', (e) => { if (e.target === el) closeZoom(); });
    document.body.append(el);
    return el;
  }

  function zoom(id) {
    zoomedId = id;
    const w = windows.find((x) => x.id === id);
    if (w) paintZoom(w);
    schedulePoll();                       // switch to the faster cadence
  }

  function closeZoom() {
    zoomedId = null;
    const el = document.getElementById('terminals-zoom');
    if (el) el.hidden = true;
    schedulePoll();
  }

  /**
   * Repaint only the screen when the window is already open, so a refresh does
   * not blow away what you are halfway through typing.
   */
  function paintZoom(w) {
    const el = zoomEl();
    el.hidden = false;

    const existing = el.querySelector('.twin-full');
    if (existing && existing.dataset.id === w.id) {
      const pre = existing.querySelector('.twin-screen');
      const stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 24;
      pre.textContent = w.screen || '(nothing on screen)';
      if (stick) pre.scrollTop = pre.scrollHeight;
      return;
    }

    el.textContent = '';
    const win = document.createElement('div');
    win.className = 'twin twin-full';
    win.dataset.id = w.id;
    win.addEventListener('click', (e) => e.stopPropagation());

    const screen = document.createElement('pre');
    screen.className = 'twin-screen twin-screen-full';
    screen.textContent = w.screen || '(nothing on screen)';

    const keys = document.createElement('div');
    keys.className = 'twin-keys';
    for (const [glyph, key] of KEYS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'twin-key';
      b.textContent = glyph;
      b.addEventListener('click', () => sendKey(w, key));
      keys.append(b);
    }

    const form = document.createElement('form');
    form.className = 'twin-compose';
    const input = document.createElement('input');
    input.className = 'twin-input';
    input.type = 'text';
    input.placeholder = 'Type into this terminal…';
    // iOS otherwise capitalises and autocorrects shell text into something
    // that will not run.
    input.autocapitalize = 'off';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('autocorrect', 'off');
    input.enterKeyHint = 'send';
    const send = document.createElement('button');
    send.type = 'submit';
    send.className = 'twin-send';
    send.textContent = 'Send';
    form.append(input, send);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = input.value;
      if (!text.trim() || sending) return;
      input.value = '';
      await sendText(w, text);
    });

    const foot = document.createElement('p');
    foot.className = 'twin-foot';
    foot.textContent = w.cwd ? `${w.cwd} — typing focuses this window on the Mac` : w.group;

    win.append(titleBar(w, { withClose: true }), screen, keys, form, foot);
    el.append(win);
    screen.scrollTop = screen.scrollHeight;
  }

  /* --------------------------------------------------------------- input */

  async function afterSend() {
    // The helper drops the snapshot cache, so a forced read shows the result.
    await new Promise((r) => setTimeout(r, 350));
    await load({ quiet: true });
  }

  async function sendText(w, text) {
    sending = true;
    try {
      await api.sendTerminalInput({ windowId: w.windowId, text, submit: true });
      await afterSend();
    } catch (err) {
      toast(err.message || 'Could not send', { error: true });
    } finally {
      sending = false;
    }
  }

  async function sendKey(w, key) {
    if (sending) return;
    sending = true;
    try {
      await api.sendTerminalInput({ windowId: w.windowId, key });
      await afterSend();
    } catch (err) {
      toast(err.message || 'Could not send', { error: true });
    } finally {
      sending = false;
    }
  }

  /* ---------------------------------------------------------- new window */

  function newSheet() {
    let el = document.getElementById('terminals-new');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'terminals-new';
    el.className = 'terminals-new';
    el.hidden = true;
    el.addEventListener('click', (e) => { if (e.target === el) el.hidden = true; });

    const card = document.createElement('div');
    card.className = 'terminals-new-card';
    card.addEventListener('click', (e) => e.stopPropagation());

    const h = document.createElement('h3');
    h.textContent = 'New Terminal window';
    const l1 = document.createElement('label');
    l1.textContent = 'Directory';
    const dir = document.createElement('input');
    dir.type = 'text';
    dir.placeholder = '~';
    dir.autocapitalize = 'off';
    dir.spellcheck = false;
    dir.setAttribute('autocorrect', 'off');
    const l2 = document.createElement('label');
    l2.textContent = 'Command (optional)';
    const cmd = document.createElement('input');
    cmd.type = 'text';
    cmd.placeholder = 'claude';
    cmd.autocapitalize = 'off';
    cmd.spellcheck = false;
    cmd.setAttribute('autocorrect', 'off');

    const row = document.createElement('div');
    row.className = 'terminals-new-row';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'twin-key';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => { el.hidden = true; });
    const create = document.createElement('button');
    create.type = 'button';
    create.className = 'twin-send';
    create.textContent = 'Open';
    create.addEventListener('click', async () => {
      create.disabled = true;
      try {
        await api.openTerminalWindow({ cwd: dir.value.trim(), command: cmd.value.trim() });
        el.hidden = true;
        cmd.value = '';
        await new Promise((r) => setTimeout(r, 600));
        await load({ quiet: true });
      } catch (err) {
        toast(err.message || 'Could not open a window', { error: true });
      } finally {
        create.disabled = false;
      }
    });
    row.append(cancel, create);

    card.append(h, l1, dir, l2, cmd, row);
    el.append(card);
    document.body.append(el);
    return el;
  }


  /* ----------------------------------------------------------------- menu */

  function menuItem(name, desc, iconName, onClick, danger = false) {
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

  /**
   * The app's only overflow menu. It used to hang off the sessions tab; when
   * that tab was removed the notifications toggle went with it, which is the
   * one setting the phone genuinely needs.
   */
  function openMenu() {
    sheet({
      title: 'Vibermote',
      build(body, close) {
        body.append(
          menuItem('Refresh now', 'Re-read the Mac\'s windows', 'refresh',
                   () => { close(); load(); }),
          // Its own sheet: turning notifications on has to explain iOS's
          // Home-Screen rule, and the permission prompt must come from a tap.
          pushMenuRow(() => { close(); openPushSheet(); }),
          menuItem('Forget token', 'Sign out of this device', 'logout', async () => {
            close();
            const ok = await confirmSheet({
              title: 'Forget token',
              message: 'The stored access token is removed from this device. You will need to paste it again.',
              confirmLabel: 'Forget token',
              danger: true,
            });
            if (ok) {
              clearToken();
              window.dispatchEvent(new CustomEvent('cr:unauthorized'));
            }
          }, true),
          h('p', { class: 'sheet-note' },
            `Connected to ${location.host}. Windows refresh every ${POLL_MS / 1000}s.`),
        );
      },
    });
  }

  /* ---------------------------------------------------------------- wiring */

  btnRefresh?.append(icon('refresh'));
  btnRefresh?.addEventListener('click', () => load());
  btnNew?.append(icon('plus'));
  btnNew?.addEventListener('click', () => { newSheet().hidden = false; });
  btnMenu?.append(icon('more'));
  btnMenu?.addEventListener('click', openMenu);

  return {
    show() {
      visible = true;
      load({ quiet: loadedOnce });
      schedulePoll();
    },
    hide() {
      visible = false;
      clearTimeout(timer);
      closeZoom();
      const sheet = document.getElementById('terminals-new');
      if (sheet) sheet.hidden = true;
    },
    refresh: () => load({ quiet: true }),
  };
}
