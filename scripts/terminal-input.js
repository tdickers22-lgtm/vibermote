// terminal-input.js — send keystrokes to one Terminal.app window.
//
// Run:  osascript -l JavaScript scripts/terminal-input.js <windowId> text  "hello"
//       osascript -l JavaScript scripts/terminal-input.js <windowId> key   enter
//
// Why keystrokes and not `do script`:
//
//   `do script "…" in window id N` looks like the obvious way to send input,
//   and it works when that window is sitting at a shell prompt. When the window
//   is busy — which is every window worth typing into, because it is running an
//   agent — Terminal treats it as "this tab cannot take a command right now"
//   and OPENS A NEW WINDOW instead. Silently. So a prompt meant for a running
//   Claude session becomes a fresh shell somewhere else.
//
//   System Events keystrokes go to whatever is focused, so the window has to be
//   brought to the front first. That is real focus theft on the Mac, and it is
//   the price of typing into a process that was not started under a PTY we own.
//   Sessions started inside tmux do not need any of this.
//
// Arguments arrive through argv rather than being interpolated into a script,
// so no quoting or escaping of the user's text is involved anywhere.

ObjC.import('Cocoa');

/** macOS virtual key codes for the keys a TUI actually needs. */
const KEY_CODES = {
  enter: 36, return: 36, escape: 53, esc: 53, tab: 48, space: 49,
  delete: 51, backspace: 51, forwarddelete: 117,
  up: 126, down: 125, left: 123, right: 124,
  home: 115, end: 119, pageup: 116, pagedown: 121,
};

/** Control combinations, written the way a terminal user says them. */
const CTRL = {
  'ctrl+c': 'c', 'ctrl+d': 'd', 'ctrl+z': 'z', 'ctrl+l': 'l',
  'ctrl+a': 'a', 'ctrl+e': 'e', 'ctrl+u': 'u', 'ctrl+k': 'k',
  'ctrl+w': 'w', 'ctrl+r': 'r', 'ctrl+p': 'p', 'ctrl+n': 'n',
  'ctrl+o': 'o', 'ctrl+b': 'b',
};

/**
 * Bring the window to the front and *wait until it is actually there*.
 *
 * A fixed sleep is not good enough. Keystrokes go to whatever is frontmost at
 * the instant they are sent, so if Terminal is still coming forward from
 * another app the text is delivered somewhere else or dropped entirely — which
 * is silent, because System Events reports success either way. Poll for the
 * real state instead, and refuse to type if it never arrives.
 */
function focusWindow(id) {
  const term = Application('Terminal');
  term.includeStandardAdditions = true;
  const win = term.windows.byId(id);
  const name = win.name();          // throws if the window is gone
  term.activate();
  win.frontmost = true;

  const se = Application('System Events');
  const proc = se.processes.byName('Terminal');
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {   // up to ~3s
    try {
      ready = proc.frontmost() && proc.windows[0].name() === name;
    } catch (e) { ready = false; }
    if (!ready) delay(0.05);
  }
  if (!ready) throw new Error('could not bring that window to the front');

  delay(0.1);                       // a beat after the switch, before typing
  return name;
}

function main(argv) {
  const id = parseInt(argv[0], 10);
  if (!Number.isFinite(id)) throw new Error('window id required');
  const mode = String(argv[1] || 'text').toLowerCase();
  const payload = argv[2] == null ? '' : String(argv[2]);

  const title = focusWindow(id);
  const se = Application('System Events');

  if (mode === 'text') {
    if (payload) se.keystroke(payload);
    // A third argument of "submit" presses Return after the text, which is what
    // sending a prompt from the phone means.
    if (String(argv[3] || '').toLowerCase() === 'submit') se.keyCode(KEY_CODES.enter);
  } else if (mode === 'key') {
    const key = payload.toLowerCase();
    if (CTRL[key]) se.keystroke(CTRL[key], { using: 'control down' });
    else if (key in KEY_CODES) se.keyCode(KEY_CODES[key]);
    else throw new Error(`unknown key: ${payload}`);
  } else {
    throw new Error(`unknown mode: ${mode}`);
  }

  return { ok: true, window: id, title };
}

function run(argv) {
  try {
    return JSON.stringify(main(argv));
  } catch (err) {
    return JSON.stringify({ ok: false, error: String((err && err.message) || err) });
  }
}
