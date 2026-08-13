// dialogs.js — find the modal dialogs blocking the Mac, and answer them.
//
// Run:  osascript -l JavaScript scripts/dialogs.js list
//       osascript -l JavaScript scripts/dialogs.js click <app> <window> <button>
//
// A Mac that has just restarted, or that has been running unattended for hours,
// accumulates things nobody has clicked: "reopen the windows?", "an app quit
// unexpectedly", "do you want to save?", a sheet on a terminal that will not
// close. Each one is invisible from the phone and each one silently blocks
// whatever was behind it.
//
// ┌─ WHAT THIS CANNOT TOUCH ───────────────────────────────────────────────┐
// │ Anything before login: the login window and a FileVault unlock run in a │
// │ context where no LaunchAgent exists yet, so nothing here is running to  │
// │ answer them. Auto-login is the only way past that, and it is the user's │
// │ to enable.                                                              │
// │                                                                         │
// │ Permission prompts (TCC) — "X wants to control Y", camera, microphone,  │
// │ screen recording — are deliberately unclickable by automation. That is  │
// │ the entire point of TCC and it is enforced below SIP. They are listed   │
// │ here so you know one is blocking you, but the button cannot be pressed  │
// │ by this or any other script.                                            │
// └─────────────────────────────────────────────────────────────────────────┘

ObjC.import('Cocoa');

/**
 * Buttons that represent a decision. A real alert offers a few of these; a
 * document window that merely reports subrole AXDialog (Preview, OBS) has
 * dozens of controls and none of them are decisions. This is the difference
 * between a useful list and a list of every window on the Mac.
 */
const DECISION = /^(ok|cancel|allow|don.t allow|open|save|don.t save|quit|continue|agree|accept|decline|yes|no|later|not now|install|update|restart|shut down|log out|reopen|discard|delete|replace|keep|review|terminate|force quit|try again|retry|skip|dismiss|close|enable|disable|grant|deny|move to trash|eject|ignore|send|report)\b/i;

/** Prompts that only a human at the keyboard can answer. */
const TCC = /wants to (?:access|control|use)|would like to (?:access|control|use)|screen recording|accessibility access|full disk access|enter (?:your |the )?password|unlock|touch id/i;

function scan() {
  const se = Application('System Events');
  const found = [];
  let procs;
  try { procs = se.processes.whose({ backgroundOnly: false })(); } catch (e) { return found; }

  for (const p of procs) {
    let app;
    try { app = p.name(); } catch (e) { continue; }
    let wins;
    try { wins = p.windows(); } catch (e) { continue; }

    for (const w of wins) {
      let title = '';
      try { title = w.name() || ''; } catch (e) {}
      let sheets = [];
      try { sheets = w.sheets(); } catch (e) {}
      let sub = '';
      try { sub = w.subrole() || ''; } catch (e) {}

      const candidates = [];
      for (const s of sheets) candidates.push({ el: s, kind: 'sheet' });
      if (!sheets.length && (sub === 'AXDialog' || sub === 'AXSystemDialog')) {
        candidates.push({ el: w, kind: 'dialog' });
      }

      for (const c of candidates) {
        let buttons = [];
        try {
          buttons = c.el.buttons()
            .map((b) => { try { return b.name(); } catch (e) { return null; } })
            .filter(Boolean);
        } catch (e) {}
        const decisive = buttons.filter((b) => DECISION.test(b));
        if (!decisive.length || buttons.length > 6) continue;

        let text = [];
        try {
          text = c.el.staticTexts()
            .map((s) => { try { return s.value(); } catch (e) { return ''; } })
            .filter(Boolean);
        } catch (e) {}

        const blob = `${title} ${text.join(' ')}`;
        found.push({
          app,
          window: title,
          kind: c.kind,
          buttons,
          text: text.slice(0, 4),
          // Reported, never clickable. See the banner above.
          human: TCC.test(blob),
        });
      }
    }
  }
  return found;
}

/**
 * Press a button on one dialog.
 *
 * Matched by app + window title + button name rather than by index, because
 * the list the phone is looking at may be seconds stale and indices shift as
 * dialogs come and go. A mismatch does nothing and says so, which is the right
 * failure: clicking the wrong button on an unknown alert is unrecoverable.
 */
function click(appName, windowTitle, buttonName) {
  const se = Application('System Events');
  const proc = se.processes.byName(appName);
  for (const w of proc.windows()) {
    let title = '';
    try { title = w.name() || ''; } catch (e) {}
    if (windowTitle && title !== windowTitle) continue;

    let sheets = [];
    try { sheets = w.sheets(); } catch (e) {}
    const targets = sheets.length ? sheets : [w];

    for (const t of targets) {
      let buttons = [];
      try { buttons = t.buttons(); } catch (e) { continue; }
      for (const b of buttons) {
        let name = '';
        try { name = b.name() || ''; } catch (e) {}
        if (name !== buttonName) continue;
        b.click();
        return { ok: true, app: appName, window: title, button: buttonName };
      }
    }
  }
  return { ok: false, error: `no "${buttonName}" button on a dialog in ${appName}` };
}

function run(argv) {
  try {
    const cmd = String(argv[0] || 'list').toLowerCase();
    if (cmd === 'list') return JSON.stringify({ ok: true, dialogs: scan() });
    if (cmd === 'click') {
      const r = click(String(argv[1] || ''), String(argv[2] || ''), String(argv[3] || ''));
      return JSON.stringify(r);
    }
    return JSON.stringify({ ok: false, error: `unknown command: ${cmd}` });
  } catch (err) {
    return JSON.stringify({ ok: false, error: String((err && err.message) || err) });
  }
}
