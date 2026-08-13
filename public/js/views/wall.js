/**
 * The wall — your Mac's Terminal windows, mirrored.
 *
 * This is not the session list. The session list is Vibermote's own tmux
 * sessions plus every dormant transcript it can reconstruct, which is a
 * catalogue. The wall is a single question: what is on the Mac's screen right
 * now? So it shows only real, currently-open Terminal windows, drawn to look
 * like the windows they are, in the same order termtile tiles them on the Mac —
 * project first, then CLI, with a project's plain shells trailing its tools.
 *
 * These windows cannot be attached to (see server/terminal-app.js), so tapping
 * one zooms it rather than opening a terminal. Nothing here can send input.
 */
import { api, ApiError } from '../api.js';
import { icon, toast } from '../ui.js';

const POLL_MS = 4000;
/** Lines of the screen a card shows. The bottom is the part that matters. */
const CARD_LINES = 14;

export function createWallView() {
  const body = document.getElementById('wall-body');
  const countEl = document.getElementById('wall-count');
  const btnRefresh = document.getElementById('btn-wall-refresh');

  let windows = [];
  let visible = false;
  let timer = 0;
  let inFlight = false;
  let loadedOnce = false;
  let zoomedId = null;

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
    }, POLL_MS);
  }

  /* -------------------------------------------------------------- render */

  function renderMessage(text) {
    body.textContent = '';
    const p = document.createElement('p');
    p.className = 'wall-empty';
    p.textContent = text;
    body.append(p);
  }

  /** Last N non-trailing lines, which is what the card has room for. */
  function tail(screen, n) {
    const lines = String(screen || '').replace(/\s+$/, '').split('\n');
    return lines.slice(Math.max(0, lines.length - n)).join('\n');
  }

  function card(w) {
    const el = document.createElement('article');
    el.className = 'twin';
    if (w.minimized) el.classList.add('twin-min');
    el.dataset.id = w.id;

    const bar = document.createElement('header');
    bar.className = 'twin-bar';
    const dots = document.createElement('span');
    dots.className = 'twin-dots';
    for (let i = 0; i < 3; i++) dots.append(document.createElement('i'));
    const title = document.createElement('span');
    title.className = 'twin-title';
    title.textContent = w.label || w.title || 'Terminal';
    bar.append(dots, title);
    if (w.minimized) {
      const badge = document.createElement('span');
      badge.className = 'twin-badge';
      badge.textContent = 'minimised';
      bar.append(badge);
    }

    const screen = document.createElement('pre');
    screen.className = 'twin-screen';
    screen.textContent = tail(w.screen, CARD_LINES) || '(nothing on screen)';

    el.append(bar, screen);
    el.addEventListener('click', () => zoom(w.id));
    return el;
  }

  function render() {
    if (!windows.length) {
      countEl && (countEl.textContent = '');
      renderMessage(
        loadedOnce
          ? 'No Terminal windows are open on the Mac.'
          : 'Loading…'
      );
      return;
    }

    countEl && (countEl.textContent = ` ${windows.length}`);
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
    let el = document.getElementById('wall-zoom');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'wall-zoom';
    el.className = 'twin-zoom';
    el.hidden = true;
    el.addEventListener('click', (e) => {
      if (e.target === el || e.target.closest('.twin-zoom-close')) closeZoom();
    });
    document.body.append(el);
    return el;
  }

  function zoom(id) {
    zoomedId = id;
    const w = windows.find((x) => x.id === id);
    if (w) paintZoom(w);
  }

  function paintZoom(w) {
    const el = zoomEl();
    el.hidden = false;
    el.textContent = '';

    const win = document.createElement('div');
    win.className = 'twin twin-full';

    const bar = document.createElement('header');
    bar.className = 'twin-bar';
    const dots = document.createElement('span');
    dots.className = 'twin-dots';
    for (let i = 0; i < 3; i++) dots.append(document.createElement('i'));
    const title = document.createElement('span');
    title.className = 'twin-title';
    title.textContent = w.title || w.label || 'Terminal';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'twin-zoom-close';
    close.textContent = 'Done';
    bar.append(dots, title, close);

    const screen = document.createElement('pre');
    screen.className = 'twin-screen twin-screen-full';
    screen.textContent = w.screen || '(nothing on screen)';

    const foot = document.createElement('p');
    foot.className = 'twin-foot';
    foot.textContent = w.cwd
      ? `${w.cwd} — mirror, read only`
      : 'mirror, read only';

    win.append(bar, screen, foot);
    el.append(win);
  }

  function closeZoom() {
    zoomedId = null;
    const el = document.getElementById('wall-zoom');
    if (el) el.hidden = true;
  }

  /* ---------------------------------------------------------------- wiring */

  btnRefresh?.append(icon('refresh'));
  btnRefresh?.addEventListener('click', () => load());

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
    },
    refresh: () => load({ quiet: true }),
  };
}
