/** Tiny DOM + chrome helpers. No framework, no innerHTML for untrusted text. */

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key === 'style') setStyle(el, value);
      else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (value === true) el.setAttribute(key, '');
      else el.setAttribute(key, String(value));
    }
  }
  append(el, children);
  return el;
}

/**
 * Apply a style object. Custom properties need setProperty — assigning
 * `el.style['--k']` sets a plain JS property that CSS never sees, which is why
 * this is not a one-line Object.assign.
 */
function setStyle(el, styles) {
  for (const [prop, value] of Object.entries(styles)) {
    if (value == null || value === false) continue;
    if (prop.startsWith('--')) el.style.setProperty(prop, String(value));
    else el.style[prop] = value;
  }
}

function append(el, nodes) {
  for (const node of nodes) {
    if (node == null || node === false || node === '') continue;
    if (Array.isArray(node)) { append(el, node); continue; }
    el.append(node instanceof Node ? node : document.createTextNode(String(node)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/* ------------------------------------------------------------------ icons */

const ICONS = {
  refresh:
    '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>' +
    '<path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  more:
    '<circle cx="12" cy="5" r="1.7" fill="currentColor" stroke="none"/>' +
    '<circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/>' +
    '<circle cx="12" cy="19" r="1.7" fill="currentColor" stroke="none"/>',
  back: '<polyline points="15 18 9 12 15 6"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2.5"/>',
  power: '<path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/>',
  keyboard:
    '<rect x="2" y="6" width="20" height="13" rx="2.5"/>' +
    '<line x1="6" y1="10" x2="6.01" y2="10"/><line x1="10" y1="10" x2="10.01" y2="10"/>' +
    '<line x1="14" y1="10" x2="14.01" y2="10"/><line x1="18" y1="10" x2="18.01" y2="10"/>' +
    '<line x1="8" y1="15" x2="16" y2="15"/>',
  clipboard:
    '<rect x="9" y="2.5" width="6" height="4" rx="1.3"/>' +
    '<path d="M15 4.5h2a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2h2"/>',
  arrowUp: '<line x1="12" y1="19" x2="12" y2="6"/><polyline points="6 12 12 6 18 12"/>',
  arrowDown: '<line x1="12" y1="5" x2="12" y2="18"/><polyline points="6 12 12 18 18 12"/>',
  arrowLeft: '<line x1="19" y1="12" x2="6" y2="12"/><polyline points="12 6 6 12 12 18"/>',
  arrowRight: '<line x1="5" y1="12" x2="18" y2="12"/><polyline points="12 6 18 12 12 18"/>',
  enter: '<polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
  logout:
    '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>' +
    '<polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  info: '<circle cx="12" cy="12" r="9.5"/><line x1="12" y1="11" x2="12" y2="16.5"/><line x1="12" y1="7.5" x2="12.01" y2="7.5"/>',
  chart:
    '<line x1="3.5" y1="20" x2="20.5" y2="20"/>' +
    '<rect x="5" y="12" width="3.6" height="5"/>' +
    '<rect x="10.2" y="7" width="3.6" height="10"/>' +
    '<rect x="15.4" y="10" width="3.6" height="7"/>',
  // Two four-point stars: the assistant tab. Drawn as strokes like every other
  // glyph here so it inherits currentColor and the shared stroke width.
  sparkle:
    '<path d="M11 3.5 12.6 8 17 9.6 12.6 11.2 11 15.7 9.4 11.2 5 9.6 9.4 8Z"/>' +
    '<path d="M17.5 14.5 18.4 17 21 17.9 18.4 18.8 17.5 21.3 16.6 18.8 14 17.9 16.6 17Z"/>',
  play: '<polygon points="7,4.5 19,12 7,19.5"/>',
  folder: '<path d="M3 7.5a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  // tmux pane controls. splitV/splitH show the divider the binding creates:
  // `%` puts panes side by side, `"` stacks them.
  splitV: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><line x1="12" y1="4.5" x2="12" y2="19.5"/>',
  splitH: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><line x1="3" y1="12" x2="21" y2="12"/>',
  panes:
    '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/>' +
    '<line x1="12" y1="4.5" x2="12" y2="19.5"/><line x1="12" y1="12" x2="21" y2="12"/>',
  zoom:
    '<polyline points="9.5 3.5 3.5 3.5 3.5 9.5"/><polyline points="14.5 3.5 20.5 3.5 20.5 9.5"/>' +
    '<polyline points="14.5 20.5 20.5 20.5 20.5 14.5"/><polyline points="9.5 20.5 3.5 20.5 3.5 14.5"/>',
};

export function icon(name, size = 21) {
  const tpl = document.createElement('template');
  tpl.innerHTML =
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ` +
    `stroke-linecap="round" stroke-linejoin="round" width="${size}" height="${size}" ` +
    `aria-hidden="true" focusable="false">${ICONS[name] || ''}</svg>`;
  return tpl.content.firstElementChild;
}

/* ----------------------------------------------------------------- toasts */

export function toast(message, { error = false, duration = 3000 } = {}) {
  const host = document.getElementById('toast-host');
  if (!host) return;
  const el = h('div', { class: `toast${error ? ' err' : ''}` }, message);
  host.append(el);
  requestAnimationFrame(() => el.classList.add('in'));
  setTimeout(() => {
    el.classList.remove('in');
    setTimeout(() => el.remove(), 220);
  }, duration);
}

/* ----------------------------------------------------------------- sheets */

let openSheets = 0;

/**
 * Bottom sheet. `build(body, close)` populates the scrollable body.
 * Returns { close }.
 */
export function sheet({ title, build, onClose }) {
  const host = document.getElementById('sheet-host');
  const backdrop = h('div', { class: 'sheet-backdrop' });
  const panel = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' });
  const body = h('div', { class: 'sheet-body' });

  panel.append(h('div', { class: 'sheet-grab' }));
  if (title) panel.append(h('h2', { class: 'sheet-title' }, title));
  panel.append(body);
  host.append(backdrop, panel);
  openSheets++;

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    openSheets--;
    backdrop.classList.remove('in');
    panel.classList.remove('in');
    document.removeEventListener('keydown', onKey);
    setTimeout(() => {
      backdrop.remove();
      panel.remove();
      onClose?.();
    }, 240);
  }

  function onKey(ev) { if (ev.key === 'Escape') close(); }

  backdrop.addEventListener('click', close);
  document.addEventListener('keydown', onKey);

  requestAnimationFrame(() => {
    backdrop.classList.add('in');
    panel.classList.add('in');
  });

  build(body, close);
  return { close, body };
}

export function confirmSheet({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value, close) => { if (!settled) { settled = true; resolve(value); } close(); };
    sheet({
      title,
      build(body, close) {
        body.append(
          h('p', { class: 'sheet-note', style: { fontSize: '13px', color: 'var(--fg-dim)', lineHeight: '1.5' } }, message),
          h('button', {
            class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`,
            style: { marginBottom: '8px' },
            onClick: () => finish(true, close),
          }, confirmLabel),
          h('button', { class: 'btn', onClick: () => finish(false, close) }, 'Cancel'),
        );
      },
      onClose() { if (!settled) { settled = true; resolve(false); } },
    });
  });
}

export function anySheetOpen() { return openSheets > 0; }

/* ------------------------------------------------------------- formatting */

export function relativeTime(value) {
  if (value == null || value === '') return '';
  const ms = typeof value === 'number'
    ? (value < 1e12 ? value * 1000 : value) // tolerate seconds or milliseconds
    : Date.parse(value);
  if (!Number.isFinite(ms)) return '';

  const seconds = (Date.now() - ms) / 1000;
  if (seconds < 0) return 'now';
  if (seconds < 45) return 'now';
  if (seconds < 90) return '1m';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  if (seconds < 604800) return `${Math.round(seconds / 86400)}d`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function timestampOf(value) {
  if (value == null || value === '') return 0;
  const ms = typeof value === 'number'
    ? (value < 1e12 ? value * 1000 : value)
    : Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

/** `/Users/me/dev/app` -> `~/dev/app` */
export function prettyPath(cwd) {
  if (!cwd) return '';
  return String(cwd).replace(/^\/(?:Users|home)\/[^/]+/, '~');
}

/** Project name for a session row. */
export function projectName(session) {
  if (session.label) return session.label;
  const cwd = String(session.cwd || '').replace(/\/+$/, '');
  const base = cwd.split('/').filter(Boolean).pop();
  return base || session.id || 'session';
}

/** Strip control characters so raw PTY previews cannot smear the list UI. */
export function sanitizePreview(text) {
  if (!text) return '';
  return String(text)
    // CSI sequences:  ESC [ ... final-byte
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')
    // OSC / DCS / APC / PM strings: ESC ] | ESC P ... terminated by BEL or ST
    .replace(/\x1b[\]P^_][\s\S]*?(?:\x07|\x1b\\)/g, '')
    // any other lone escape sequence (ESC + one byte)
    .replace(/\x1b[@-Z\\-_]?/g, '')
    // remaining C0/C1 control bytes -> space
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
