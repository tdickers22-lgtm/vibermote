/**
 * Thin wrapper over the tmux CLI.
 *
 * Two invariants hold everywhere in this file:
 *   1. We only ever read or mutate sessions whose name starts with TMUX_PREFIX,
 *      so the user's own tmux sessions are untouchable.
 *   2. tmux exiting non-zero is normal (`no server running` when nothing is up),
 *      so every call resolves rather than throwing on ordinary failure.
 */
import { execFile } from 'node:child_process';
import { LOCALE, TMUX_BIN, TMUX_PREFIX } from './config.js';
import { log } from './util.js';

const EXEC_TIMEOUT_MS = 5000;

/**
 * Environment for every tmux invocation.
 *
 * The locale is forced because a tmux that cannot see a UTF-8 locale silently
 * leaves UTF-8 mode, and under launchd there is no LANG at all. See LOCALE in
 * config.js for why that is not cosmetic.
 */
const TMUX_ENV = { ...process.env, LANG: LOCALE, LC_ALL: LOCALE };

/** Run tmux, resolving {code, stdout, stderr} instead of throwing. */
export function tmux(args, { timeout = EXEC_TIMEOUT_MS, maxBuffer = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile(TMUX_BIN, args, { timeout, maxBuffer, encoding: 'utf8', env: TMUX_ENV }, (err, stdout, stderr) => {
      if (err) {
        resolve({
          ok: false,
          code: typeof err.code === 'number' ? err.code : 1,
          stdout: stdout || '',
          stderr: stderr || err.message || '',
        });
        return;
      }
      resolve({ ok: true, code: 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

/** True when the tmux server reported "no server running" rather than a real error. */
function isNoServer(stderr) {
  return /no server running|error connecting to|No such file or directory/i.test(stderr || '');
}

export function isManaged(name) {
  return typeof name === 'string' && name.startsWith(TMUX_PREFIX);
}

/**
 * Session names are built by kinds.js (`tmuxNameFor`), which encodes the kind
 * into the name as `ccr-<kind>-<slug>`. tmux uses ':' and '.' to address
 * windows and panes, so the slug there excludes them by construction.
 */

/**
 * Append -2, -3, … until the name is free.
 *
 * listSessions() reports `{ok, sessions}`, and `ok:false` means tmux could not
 * be queried at all — which is emphatically not "there are no sessions". Taking
 * it as an empty list here would hand back a name that is already in use, and
 * `new-session` would then fail with tmux's opaque "duplicate session" error.
 * Failing loudly with the real reason is the honest answer.
 */
export async function uniqueSessionName(base) {
  const listing = await listSessions();
  if (!listing.ok) {
    throw new Error('cannot reach tmux to pick a free session name — is the tmux server healthy?');
  }
  const existing = new Set(listing.sessions.map((s) => s.name));
  if (!existing.has(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}-${i}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/**
 * Field separator for `-F` output.
 *
 * This was ASCII 0x1F (unit separator), which is the obviously correct choice
 * and was wrong here: a tmux running outside UTF-8 mode rewrites non-printable
 * bytes in format output to '_'. Under launchd (which supplies no LANG) every
 * field of every session therefore ran together into a single string, so a
 * session name came back as "ccr-shell-x_1786_1786_1_1_/path_zsh_100_29". That
 * name matched no broker and no metadata key, which in turn made pruneMeta()
 * delete the metadata of sessions that were still running.
 *
 * A printable sentinel cannot be rewritten, so parsing no longer depends on the
 * locale being right. `pane_current_path` is the one field with genuinely
 * unconstrained content, so it goes last and is reassembled from everything
 * that remains — an exotic path cannot shift the other fields.
 */
const SEP = '@|CCR|@';

const LIST_FIELDS = [
  '#{session_name}',
  '#{session_created}',
  '#{session_activity}',
  '#{session_attached}',
  '#{session_windows}',
  '#{pane_current_command}',
  '#{window_width}',
  '#{window_height}',
  '#{pane_current_path}', // last: unconstrained content
];
const LIST_FORMAT = LIST_FIELDS.join(SEP);

/**
 * All tmux sessions we manage.
 *
 * @returns {Promise<{ok: boolean, sessions: Array<object>}>} `ok` is false only
 * when tmux could not be queried at all. Callers must not treat that as "there
 * are no sessions" — doing so throws away live state.
 */
export async function listSessions() {
  const res = await tmux(['list-sessions', '-F', LIST_FORMAT]);
  if (!res.ok) {
    if (isNoServer(res.stderr)) return { ok: true, sessions: [] }; // genuinely none
    log.warn('tmux list-sessions failed:', res.stderr.trim());
    return { ok: false, sessions: [] };
  }

  const sessions = [];
  for (const line of res.stdout.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split(SEP);
    if (parts.length < LIST_FIELDS.length) {
      log.warn(`unparseable tmux list-sessions line (${parts.length} fields): ${line.slice(0, 120)}`);
      continue; // never emit a session whose name we are unsure of
    }
    const [name, created, activity, attached, windows, command, width, height] = parts;
    const cwd = parts.slice(LIST_FIELDS.length - 1).join(SEP);

    if (!isManaged(name)) continue; // never surface the user's own sessions
    sessions.push({
      name,
      createdAt: Number(created) * 1000 || null,
      activityAt: Number(activity) * 1000 || null,
      attachedClients: Number(attached) || 0,
      windows: Number(windows) || 1,
      cwd: cwd || null,
      command: command || null,
      cols: Number(width) || null,
      rows: Number(height) || null,
    });
  }
  return { ok: true, sessions };
}

export async function hasSession(name) {
  if (!isManaged(name)) return false;
  const res = await tmux(['has-session', '-t', `=${name}`]);
  return res.ok;
}

/**
 * Create a detached session running `command` (argv array) in `cwd`.
 * Detached creation means the session exists before any PTY attaches, so the
 * attach path is uniform for brand-new and pre-existing sessions alike.
 */
export async function newSession({ name, cwd, command, env = {} }) {
  if (!isManaged(name)) throw new Error(`refusing to create unmanaged session "${name}"`);

  const args = ['new-session', '-d', '-s', name];
  if (cwd) args.push('-c', cwd);

  // -e sets environment for the new session (tmux >= 3.2).
  for (const [k, v] of Object.entries(env)) {
    if (v != null) args.push('-e', `${k}=${v}`);
  }

  if (Array.isArray(command) && command.length) args.push('--', ...command);

  const res = await tmux(args, { timeout: 10_000 });
  if (!res.ok) throw new Error(`tmux new-session failed: ${res.stderr.trim() || `exit ${res.code}`}`);

  // Per-session options only — never `-g`, which would rewrite the user's tmux.
  // The status bar costs a line of vertical space that matters a lot on a phone.
  await tmux(['set-option', '-t', `=${name}`, 'status', 'off']);
  // Resize to the smallest *attached* client rather than the largest ever seen,
  // so a phone attaching alongside a desktop still gets a readable layout.
  await tmux(['set-option', '-t', `=${name}`, 'aggressive-resize', 'on']);
  // Long scrollback: the replay on attach is only as good as the history tmux kept.
  await tmux(['set-option', '-t', `=${name}`, 'history-limit', '20000']);

  return name;
}

/**
 * Recent scrollback for instant context on attach.
 * `-e` keeps SGR escape sequences so colour survives; `-J` unwraps lines that
 * tmux hard-wrapped, which otherwise re-wrap wrongly at the phone's width.
 */
export async function capturePane(name, lines) {
  if (!isManaged(name)) return '';
  const res = await tmux(
    ['capture-pane', '-p', '-e', '-J', '-S', `-${Math.max(0, lines)}`, '-t', `=${name}`],
    { timeout: 5000 },
  );
  if (!res.ok) {
    log.debug(`capture-pane failed for ${name}:`, res.stderr.trim());
    return '';
  }
  // capture-pane pads the bottom with blank lines; trim them so the replay does
  // not push the live cursor position off-screen.
  return res.stdout.replace(/\n+$/, '');
}

export async function killSession(name) {
  if (!isManaged(name)) throw new Error(`refusing to kill unmanaged session "${name}"`);
  const res = await tmux(['kill-session', '-t', `=${name}`]);
  if (!res.ok && !isNoServer(res.stderr) && !/can't find session/i.test(res.stderr)) {
    throw new Error(`tmux kill-session failed: ${res.stderr.trim() || `exit ${res.code}`}`);
  }
  return true;
}

export async function serverVersion() {
  const res = await tmux(['-V'], { timeout: 3000 });
  return res.ok ? res.stdout.trim() : null;
}
