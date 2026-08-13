// terminal-open.js — open a new Terminal.app window on the Mac.
//
// Run:  osascript -l JavaScript scripts/terminal-open.js [cwd] [command]
//
// `do script` with no `in` clause is the one case where Terminal creating a new
// window is exactly what we want. The window appears on the Mac like any other,
// so termtile tiles it and the wall picks it up on its next refresh.
//
// The directory and the command are separate arguments and are quoted here
// rather than pasted together, because a project path with a space in it would
// otherwise turn one command into two.

ObjC.import('Cocoa');

/** Single-quote for the shell: wrap, and close/escape/reopen around each quote. */
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function main(argv) {
  const cwd = argv[0] ? String(argv[0]) : '';
  const command = argv[1] ? String(argv[1]) : '';

  const parts = [];
  if (cwd) {
    const fm = $.NSFileManager.defaultManager;
    const isDir = Ref();
    if (!fm.fileExistsAtPathIsDirectory(cwd, isDir) || !isDir[0]) {
      throw new Error(`no such directory: ${cwd}`);
    }
    parts.push(`cd ${shellQuote(cwd)}`);
  }
  if (command) parts.push(command);
  // An empty `do script ""` still opens a window at the login shell, which is
  // the "just give me a terminal" case.
  const script = parts.join(' && ');

  const term = Application('Terminal');
  term.includeStandardAdditions = true;
  // Deliberately no activate() here. Activating Terminal before doScript makes
  // it open a second, empty window of its own, so one request produced two
  // windows. doScript creates and focuses the window by itself.
  term.doScript(script);
  delay(0.4);                       // the window needs a beat to exist

  // doScript returns the tab; the id we care about is its window's.
  let id = null;
  try {
    const ids = term.windows.id();
    id = ids.length ? ids[0] : null;   // the new window is frontmost
  } catch (e) { /* leave null */ }

  return { ok: true, id, cwd: cwd || null, command: command || null };
}

function run(argv) {
  try {
    return JSON.stringify(main(argv));
  } catch (err) {
    return JSON.stringify({ ok: false, error: String((err && err.message) || err) });
  }
}
