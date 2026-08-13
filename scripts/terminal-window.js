// terminal-window.js — do to a Terminal window what you could do at the Mac.
//
// Run:  osascript -l JavaScript scripts/terminal-window.js <action> <windowId> [arg]
//
// Actions:
//   close [force]   close it; `force` terminates running processes without asking
//   minimize        send it to the Dock
//   restore         bring it back from the Dock
//   front           bring it to the front on the Mac
//   zoom            toggle the green-button zoom
//   scrollback [n]  the last n lines of real scrollback (default 400)
//   clear           clear the screen (and the scrollback with it)
//   signal <sig>    signal the foreground job: INT, TERM, KILL, QUIT, TSTP
//   newtab          open a tab in this window, in the same directory
//
// Closing is the interesting one. Terminal refuses to close a window with a
// running process and puts up a "terminate running processes?" sheet instead,
// which from the phone looks like nothing happening. So a close reports whether
// a sheet appeared, and `force` answers it.

ObjC.import('Cocoa');

function term() { return Application('Terminal'); }

function win(id) {
  const w = term().windows.byId(id);
  w.name();                       // throws if that window is gone
  return w;
}

/** Does this window have a confirmation sheet on it right now? */
function sheetOn(id) {
  try {
    const proc = Application('System Events').processes.byName('Terminal');
    for (const w of proc.windows()) {
      let sheets = [];
      try { sheets = w.sheets(); } catch (e) { continue; }
      if (!sheets.length) continue;
      let buttons = [];
      try {
        buttons = sheets[0].buttons()
          .map((b) => { try { return b.name(); } catch (e) { return null; } })
          .filter(Boolean);
      } catch (e) {}
      let text = [];
      try {
        text = sheets[0].staticTexts()
          .map((s) => { try { return s.value(); } catch (e) { return ''; } })
          .filter(Boolean);
      } catch (e) {}
      return { present: true, window: w.name(), buttons, text: text.slice(0, 2) };
    }
  } catch (e) { /* fall through */ }
  return { present: false };
}

function clickSheet(label) {
  const proc = Application('System Events').processes.byName('Terminal');
  for (const w of proc.windows()) {
    let sheets = [];
    try { sheets = w.sheets(); } catch (e) { continue; }
    if (!sheets.length) continue;
    for (const b of sheets[0].buttons()) {
      let name = '';
      try { name = b.name() || ''; } catch (e) {}
      if (name === label) { b.click(); return true; }
    }
  }
  return false;
}

/**
 * Signal whatever is running in the window.
 *
 * The tty is the handle: every process in that window shares it, so `ps -t`
 * finds the job without needing to have started it. The shell itself is left
 * alone — signalling that closes the window, which is what `close` is for.
 */
function signalWindow(id, sig) {
  const allowed = new Set(['INT', 'TERM', 'KILL', 'QUIT', 'TSTP', 'HUP']);
  const s = String(sig || 'INT').toUpperCase().replace(/^SIG/, '');
  if (!allowed.has(s)) throw new Error(`refusing to send signal ${s}`);

  const tty = term().windows.byId(id).selectedTab.tty();
  if (!tty) throw new Error('no tty for that window');
  const dev = tty.replace('/dev/', '');

  const app = Application.currentApplication();
  app.includeStandardAdditions = true;
  // The foreground process group, minus login and the shell itself.
  const script =
    `ps -t ${dev} -o pid=,stat=,comm= | ` +
    `awk '$2 ~ /\\+/ && $3 !~ /^(login|-?(zsh|bash|sh|fish))$/ {print $1}'`;
  const out = String(app.doShellScript(script) || '').trim();
  const pids = out.split(/[\r\n]+/).filter(Boolean);
  if (!pids.length) return { ok: true, signalled: [], note: 'nothing running in that window' };
  app.doShellScript(`kill -${s} ${pids.join(' ')}`);
  return { ok: true, signalled: pids, signal: s };
}

function main(argv) {
  const action = String(argv[0] || '').toLowerCase();
  const id = parseInt(argv[1], 10);
  if (!Number.isFinite(id)) throw new Error('window id required');
  const arg = argv[2];

  switch (action) {
    case 'close': {
      const w = win(id);
      const busy = (() => { try { return w.selectedTab.busy(); } catch (e) { return false; } })();
      w.close();
      delay(0.6);
      const sheet = sheetOn(id);
      if (sheet.present && String(arg || '').toLowerCase() === 'force') {
        // Terminal labels it "Terminate"; accept OK as a fallback wording.
        const clicked = clickSheet('Terminate') || clickSheet('OK');
        delay(0.5);
        return { ok: true, closed: clicked, forced: true, wasBusy: busy };
      }
      if (sheet.present) {
        return {
          ok: true, closed: false, wasBusy: busy, blocked: true,
          sheet,
          note: 'Terminal is asking before killing the running process. Answer it, or close with force.',
        };
      }
      return { ok: true, closed: true, wasBusy: busy };
    }

    case 'minimize': win(id).miniaturized = true; return { ok: true, minimized: true };
    case 'restore': win(id).miniaturized = false; return { ok: true, minimized: false };
    case 'front': {
      const w = win(id);
      term().activate();
      w.frontmost = true;
      return { ok: true, front: true };
    }
    case 'zoom': {
      const w = win(id);
      const z = !w.zoomed();
      w.zoomed = z;
      return { ok: true, zoomed: z };
    }

    case 'scrollback': {
      const n = Math.max(1, Math.min(parseInt(arg, 10) || 400, 5000));
      // `history` is the entire buffer and runs to megabytes, so it is tailed
      // here rather than shipped whole to a phone.
      const text = String(win(id).selectedTab.history() || '');
      const lines = text.replace(/\s+$/, '').split('\n');
      return { ok: true, lines: lines.length, text: lines.slice(-n).join('\n') };
    }

    case 'clear': {
      // Send the keystroke rather than writing `clear`, so it works even when
      // something is running and would swallow typed text.
      const w = win(id);
      term().activate();
      w.frontmost = true;
      delay(0.2);
      Application('System Events').keystroke('k', { using: 'command down' });
      return { ok: true, cleared: true };
    }

    case 'signal': return signalWindow(id, arg);

    case 'newtab': {
      const w = win(id);
      const tty = w.selectedTab.tty();
      const app = Application.currentApplication();
      app.includeStandardAdditions = true;
      let cwd = '';
      try {
        const dev = String(tty).replace('/dev/', '');
        const pid = String(app.doShellScript(
          `ps -t ${dev} -o pid=,comm= | awk '$2 ~ /(zsh|bash|sh|fish)$/ {print $1; exit}'`
        )).trim();
        if (pid) {
          cwd = String(app.doShellScript(
            `lsof -a -d cwd -p ${pid} -Fn 2>/dev/null | awk '/^n/{print substr($0,2); exit}'`
          )).trim();
        }
      } catch (e) { /* open in the default directory */ }
      term().activate();
      w.frontmost = true;
      delay(0.2);
      Application('System Events').keystroke('t', { using: 'command down' });
      delay(0.5);
      if (cwd) {
        Application('System Events').keystroke(`cd ${JSON.stringify(cwd)}`);
        Application('System Events').keyCode(36);
      }
      return { ok: true, newTab: true, cwd: cwd || null };
    }

    default: throw new Error(`unknown action: ${action}`);
  }
}

function run(argv) {
  try {
    return JSON.stringify(main(argv));
  } catch (err) {
    return JSON.stringify({ ok: false, error: String((err && err.message) || err) });
  }
}
