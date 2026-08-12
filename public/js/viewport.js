/**
 * Viewport plumbing for iOS.
 *
 * The iOS software keyboard does NOT resize the window — `window.innerHeight`
 * stays put while the keyboard covers the bottom of the screen, which is how
 * naive terminal web apps end up typing behind the keyboard. `visualViewport`
 * reports the region actually visible, so we size and offset #app to match it.
 *
 * Also toggles `html.kb-open`, which drops the keybar's bottom safe-area inset:
 * when the keyboard is up there is no home indicator left to dodge.
 */

const KEYBOARD_THRESHOLD = 90; // px of occlusion before we call it "keyboard open"

const listeners = new Set();

let app = null;
let lastHeight = 0;
let lastKeyboard = 0;
let rafId = 0;

function measure() {
  const vv = window.visualViewport;
  const height = Math.round(vv ? vv.height : window.innerHeight);
  const offsetTop = vv ? vv.offsetTop : 0;
  // Occlusion = layout viewport minus visible viewport, minus any page offset.
  const keyboard = Math.max(0, Math.round(window.innerHeight - height - offsetTop));
  return { height, offsetTop, keyboard, keyboardOpen: keyboard > KEYBOARD_THRESHOLD };
}

function apply() {
  rafId = 0;
  if (!app) return;

  const m = measure();

  app.style.height = `${m.height}px`;
  // Keep the app box glued to the visible region when iOS scrolls the layout
  // viewport to reveal a focused field.
  app.style.transform = m.offsetTop ? `translate3d(0, ${m.offsetTop}px, 0)` : '';

  const root = document.documentElement;
  root.classList.toggle('kb-open', m.keyboardOpen);
  root.style.setProperty('--kb-height', `${m.keyboard}px`);

  const changed = m.height !== lastHeight || m.keyboard !== lastKeyboard;
  lastHeight = m.height;
  lastKeyboard = m.keyboard;

  for (const fn of listeners) {
    try { fn(m, changed); } catch (err) { console.error('[viewport]', err); }
  }
}

export function syncViewport() {
  if (rafId) return;
  rafId = requestAnimationFrame(apply);
}

/** Subscribe to viewport changes. Returns an unsubscribe function. */
export function onViewport(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function viewportState() { return measure(); }

export function initViewport() {
  app = document.getElementById('app');

  const vv = window.visualViewport;
  if (vv) {
    vv.addEventListener('resize', syncViewport);
    vv.addEventListener('scroll', syncViewport);
  }
  window.addEventListener('resize', syncViewport);
  window.addEventListener('focusin', syncViewport);
  window.addEventListener('focusout', () => {
    // iOS reports the collapsed keyboard a beat after blur.
    setTimeout(syncViewport, 60);
    setTimeout(syncViewport, 300);
  });
  window.addEventListener('orientationchange', () => {
    setTimeout(syncViewport, 80);
    setTimeout(syncViewport, 350); // after the rotate animation settles
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) setTimeout(syncViewport, 60);
  });

  // Safari sometimes leaves the layout viewport scrolled after a keyboard
  // dismissal; force it back so our fixed box lines up with the screen.
  window.addEventListener('scroll', () => {
    if (window.scrollY !== 0) window.scrollTo(0, 0);
  }, { passive: true });

  apply();
}
