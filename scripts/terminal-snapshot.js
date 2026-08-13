// terminal-snapshot.js — one JSON snapshot of every Terminal.app window.
//
// Run:  osascript -l JavaScript scripts/terminal-snapshot.js
//
// Vibermote's own sessions live in tmux, which it owns end to end. This script
// covers the other half: the terminals you already had open before Vibermote
// existed, running under a plain login shell with no tmux anywhere. Those
// cannot be attached to from outside the machine, but Terminal will hand over
// what is on their screen, which is enough to mirror them to the phone.
//
// Everything is gathered in a single osascript run on purpose. Each run costs
// ~100ms of interpreter startup, so doing the process and directory lookups
// here rather than back in Node keeps a refresh to one spawn instead of three.
//
// Output: {"ok":true,"windows":[...]} on stdout, or {"ok":false,"error":...}.

ObjC.import('Cocoa');

function main(light) {
  const term = Application('Terminal');
  if (!isRunning('com.apple.Terminal')) return { ok: true, windows: [] };

  const ids = term.windows.id();
  if (!ids.length) return { ok: true, windows: [] };

  // Bulk property fetches: one Apple Event each for the whole window list,
  // rather than one per window per property.
  const names = bulk(() => term.windows.name(), ids.length, '');
  const mini = bulk(() => term.windows.miniaturized(), ids.length, false);
  const ttys = bulk(() => term.windows.selectedTab.tty(), ids.length, '');
  const procs = bulk(() => term.windows.selectedTab.processes(), ids.length, []);
  // `contents` is the visible screen. `history` is the entire scrollback and
  // runs to megabytes per window, which is far too much to ship on every poll.
  const screens = bulk(() => term.windows.selectedTab.contents(), ids.length, '');

  // The watcher only needs screens, and ttyCwdMap() is the expensive half of
  // this script (a ps sweep plus lsof). Skip it when the caller says so.
  const cwds = light ? {} : ttyCwdMap();
  const home = ObjC.unwrap($.NSHomeDirectory());

  const windows = ids.map((id, i) => {
    const cwd = cwds[ttys[i]] || null;
    return {
      id,
      title: names[i] || '',
      tty: ttys[i] || null,
      cwd,
      project: projectFor(cwd, home),
      cli: cliFor(procs[i]),
      processes: procs[i] || [],
      minimized: Boolean(mini[i]),
      screen: trimBlank(String(screens[i] || ''))
    };
  });

  return { ok: true, windows };
}

/** A bulk accessor returns one value per window, or throws; fall back to blanks. */
function bulk(fn, n, blank) {
  try {
    const v = fn();
    if (Array.isArray(v) && v.length === n) return v;
  } catch (e) { /* fall through */ }
  return new Array(n).fill(blank);
}

function isRunning(bundleId) {
  const apps = $.NSWorkspace.sharedWorkspace.runningApplications;
  for (let i = 0; i < apps.count; i++) {
    const a = apps.objectAtIndex(i);
    if (!a.bundleIdentifier.isNil() && ObjC.unwrap(a.bundleIdentifier) === bundleId) return true;
  }
  return false;
}

/** Drop the blank lines Terminal pads the visible screen out with. */
function trimBlank(s) {
  return s.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
}

/* ------------------------------------------------------------------ shape */

// Terminal reports a tab's process chain as [login, -zsh, <the cli>, ...children],
// so the first entry that is neither a shell nor a wrapper is the CLI in use.
const SHELLISH = new Set(['login', 'zsh', 'bash', 'sh', 'fish', 'dash', 'ksh', 'tcsh',
                          'csh', 'screen', 'tmux', 'env', 'sudo', 'caffeinate', 'script',
                          'nohup', 'time', 'stdbuf']);
const ALIAS = { agent: 'cursor-agent' };   // cursor-agent's inner process is just "agent"

function cliFor(procs) {
  for (const p of (procs || [])) {
    const name = String(p).replace(/^-/, '');
    if (SHELLISH.has(name)) continue;
    return ALIAS[name] || name;
  }
  return null;                              // a bare shell, not running any tool
}

// The project is the git checkout the shell sits in, so a dev server in
// repo/backend groups with an agent in repo/frontend. The home directory is
// loose work rather than a project, and reports null.
function projectFor(cwd, home) {
  if (!cwd) return null;
  const fm = $.NSFileManager.defaultManager;
  let d = cwd;
  for (let i = 0; i < 24 && d.length > 1; i++) {
    if (d === home) break;
    if (fm.fileExistsAtPath(d + '/.git')) return d.slice(d.lastIndexOf('/') + 1);
    d = d.slice(0, d.lastIndexOf('/'));
  }
  if (cwd === home) return null;
  return cwd.slice(cwd.lastIndexOf('/') + 1) || null;
}

// Terminal knows each window's tty but not its directory. The shell owning that
// tty does, so look the shells up once and read their cwd straight out of lsof.
function ttyCwdMap() {
  const script =
    'M=$(ps -A -o tty=,pid=,comm= | awk \'{n=split($3,a,"/"); c=a[n]; sub(/^-/,"",c); ' +
    'if (c ~ /^(zsh|bash|fish|sh|dash|tcsh|ksh)$/) print $1" "$2}\'); ' +
    '[ -z "$M" ] && exit 0; ' +
    'echo "$M" | sed \'s/^/T /\'; ' +
    'P=$(echo "$M" | awk \'{print $2}\' | paste -sd, -); ' +
    'lsof -a -d cwd -p "$P" -Fn 2>/dev/null | ' +
    'awk \'/^p/{p=substr($0,2)} /^n/{print "C "p" "substr($0,2)}\'';
  const out = {};
  let text;
  try {
    const sh = Application.currentApplication();
    sh.includeStandardAdditions = true;
    text = sh.doShellScript(script);
  } catch (e) { return out; }
  const ttyPid = {}, pidCwd = {};
  // doShellScript returns carriage-return separated lines, not newlines.
  for (const line of String(text).split(/[\r\n]+/)) {
    const p = line.split(' ');
    if (p[0] === 'T') ttyPid[p[1]] = p[2];
    else if (p[0] === 'C') pidCwd[p[1]] = p.slice(2).join(' ');
  }
  for (const tty in ttyPid) {
    const cwd = pidCwd[ttyPid[tty]];
    if (cwd) out['/dev/' + tty] = cwd;
  }
  return out;
}

function run(argv) {
  try {
    return JSON.stringify(main((argv || []).indexOf('light') >= 0));
  } catch (err) {
    return JSON.stringify({ ok: false, error: String(err && err.message || err) });
  }
}
