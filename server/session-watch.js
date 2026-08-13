/**
 * Watches managed tmux sessions for the two moments worth waking a phone for:
 * a process that finished, and a session that has gone quiet in a way that
 * looks like it is waiting for the user.
 *
 * ┌─ WHY THIS POLLS TMUX INSTEAD OF WATCHING THE PTY ──────────────────────┐
 * │ The obvious place to detect this is SessionBroker's PTY data stream. It │
 * │ is the wrong place: the PTY only exists while a phone is attached, and  │
 * │ is dropped IDLE_DETACH_MS after the last viewer leaves. The entire      │
 * │ scenario this feature exists for — user walks away, agent finishes      │
 * │ twenty minutes later — happens with no PTY attached and no broker in    │
 * │ memory. tmux is the only thing still watching, so we ask tmux.          │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * The busy/quiet signal is a hash of the pane's *visible* region, not
 * `session_activity`. tmux bumps activity for any output at all, while what we
 * actually care about is whether the screen still looks the same: a TUI redraw
 * that changes nothing should read as quiet, and a spinner that changes one
 * character should read as busy. Hashing the rendered pane gets both right.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import {
  PUSH_EXIT_SETTLE_MS,
  PUSH_MIN_RUN_MS,
  PUSH_POLL_MS,
  PUSH_QUIET_MS,
  TMUX_PREFIX,
} from './config.js';
import { KINDS, DEFAULT_KIND, kindFromTmuxName } from './kinds.js';
import { getMeta } from './meta.js';
import { notifySessionEvent, forgetSessionState, subscriptionCount } from './push.js';
import * as tmuxApi from './tmux.js';
import { log } from './util.js';

/**
 * Commands that mean "no foreground job" — the login shell the wrapper drops
 * into after a tool exits (see buildKindCommand in sessions.js), or the shell a
 * `shell` session is. tmux reports these without the leading dash a login shell
 * carries in argv[0], but both spellings are accepted.
 */
const SHELL_COMMANDS = new Set([
  'sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'tcsh', 'csh',
  '-sh', '-bash', '-zsh', '-fish',
]);

/**
 * The primary "the job finished" signal, and the reason exit detection is
 * reliable at all.
 *
 * buildKindCommand() in sessions.js wraps every non-shell kind as
 * `<tool>; status=$?; printf '[%s exited with status %s — shell follows]'; exec $SHELL`,
 * so this line appearing in the pane is this codebase telling us, in its own
 * words, that the thing the user launched has ended.
 *
 * It is used instead of `pane_current_command` because that field reports the
 * pane's foreground process GROUP LEADER, which for a `sh -c` wrapper is the
 * wrapper itself for the whole run: a session running `sleep 6` reports "bash"
 * throughout and then "zsh", never "sleep". The transition is invisible.
 * (pane_current_command is still watched below, because an INTERACTIVE shell
 * does give each job its own process group, so it catches the different case of
 * a user typing a long command into a shell session and walking away.)
 *
 * The wrapper `exec`s the shell afterwards, so it runs at most once per
 * session — one sentinel, one notification, no re-arming needed.
 */
const EXIT_SENTINEL = /exited with status (\d+)/;

/**
 * Tails that mean "a human has to do something".
 *
 * These are matched against the last few non-empty lines of the pane, and only
 * ever consulted after the screen has already been still for PUSH_QUIET_MS with
 * nobody watching. They are a filter on an existing candidate, not a detector:
 * a session that goes quiet without matching any of them produces silence,
 * which is the failure mode to prefer.
 */
const WAITING_PATTERNS = [
  /\?\s*for shortcuts/i,               // Claude Code / Codex idle input box
  /\bdo you want to\b/i,               // Claude Code permission prompt
  /\bwaiting for (?:your )?input\b/i,
  /\(y(?:es)?\/n(?:o)?\)/i,
  /\[y\/n\]/i,
  /^\s*(?:[❯>*]\s*)?[1-9][.)]\s*(?:yes|no|allow|deny|approve|reject)\b/im,
  /\bpress (?:enter|any key|return)\b/i,
  /\b(?:continue|proceed|overwrite|confirm)\?\s*$/im,
  /\b(?:password|passphrase)\s*:\s*$/im,
  /^\s*[>❯]\s*$/m,                     // an empty prompt box on its own line
  /[$%#❯➜]\s*$/,                       // a plain shell prompt at the very end
];

/**
 * Tails that mean the opposite — the tool is working and merely rendered a
 * static frame. A veto, because "it is still thinking" is the single most
 * expensive false positive: it trains the user to ignore the notification.
 */
const BUSY_PATTERNS = [
  /\besc to interrupt\b/i,
  /\bctrl\+c to (?:stop|cancel|interrupt)\b/i,
  /\brunning\.{3}/i,
  /\bthinking\b/i,
];

/** tmux name -> observed state */
const watched = new Map();

let timer = null;
let viewersOf = () => 0;
/**
 * Until the first sweep lands we know nothing, so nothing may be notified. This
 * is what stops a server restart from announcing every session that was already
 * sitting idle when it started.
 */
let primed = false;

function hashOf(text) {
  return crypto.createHash('sha1').update(text).digest('base64');
}

function isShell(command) {
  return !command || SHELL_COMMANDS.has(command);
}

/** The session's public name: the project directory, never the label. */
function projectNameFor(session) {
  const dir = session.cwd || getMeta(session.name)?.projectDir;
  if (dir) return path.basename(String(dir).replace(/\/+$/, '')) || dir;
  const rest = session.name.slice(TMUX_PREFIX.length);
  const kindId = kindFromTmuxName(session.name);
  return (kindId && rest.startsWith(`${kindId}-`) ? rest.slice(kindId.length + 1) : rest) || session.name;
}

function kindLabelFor(name) {
  const kindId = kindFromTmuxName(name) || getMeta(name)?.kind || DEFAULT_KIND;
  return KINDS[kindId]?.displayName || '';
}

/** The last few non-empty lines, which is where every prompt in practice lives. */
function tailOf(pane, lines = 12) {
  return pane
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim())
    .slice(-lines)
    .join('\n');
}

function looksLikeWaiting(pane) {
  const tail = tailOf(pane);
  if (!tail) return false;
  if (BUSY_PATTERNS.some((re) => re.test(tail))) return false;
  return WAITING_PATTERNS.some((re) => re.test(tail));
}

/* ------------------------------------------------------------------ *
 * The sweep
 * ------------------------------------------------------------------ */

async function sweep() {
  // Nobody to tell: skip the whole sweep rather than burning tmux calls every
  // few seconds for a feature the user has not switched on.
  if (!subscriptionCount()) {
    // State is dropped so that enabling notifications later starts clean rather
    // than firing on a transition observed while nobody was subscribed.
    if (watched.size) watched.clear();
    primed = false;
    return;
  }

  const listing = await tmuxApi.listSessions();
  // `ok:false` means tmux could not be queried, which is emphatically not "every
  // session ended" — treating it as such would push an "ended" notification for
  // every running session. Skip the tick entirely.
  if (!listing.ok) return;

  const now = Date.now();
  const present = new Set(listing.sessions.map((s) => s.name));

  /* -------- sessions that disappeared -------- */
  for (const [name, state] of [...watched]) {
    if (present.has(name)) continue;
    watched.delete(name);
    if (!primed || state.suppressed) continue;
    await fire(name, state, 'ended');
  }

  /* -------- sessions that are still here -------- */
  for (const session of listing.sessions) {
    const pane = await tmuxApi.capturePaneVisible(session.name);
    const hash = hashOf(pane);

    const hasSentinel = EXIT_SENTINEL.test(pane);

    let state = watched.get(session.name);
    if (!state) {
      state = {
        firstSeenAt: now,
        command: session.command,
        commandSince: now,
        hash,
        lastChangeAt: now,
        // Seeded from the first look so a session that had already finished
        // before we started watching is not announced as finishing now. That
        // covers two cases at once: a session adopted across a server restart,
        // and a command so short it was over before the first sweep.
        sawExitSentinel: hasSentinel,
        // Nothing is notified until we have watched the screen actually change,
        // so a session that has been parked at a prompt since before we started
        // never fires. Re-armed on every change.
        everChanged: false,
        armed: false,
        suppressed: false,
        /**
         * Changes before this instant do not re-arm the idle detector.
         *
         * A session already showing the exit sentinel the first time we look is
         * sitting at a post-exit shell prompt, and that prompt finishing its
         * paint is not news — without this, a `custom` session running something
         * trivial would be announced as "waiting for your input" a minute later.
         */
        freezeArmUntil: hasSentinel ? now + PUSH_EXIT_SETTLE_MS : 0,
        projectName: projectNameFor(session),
        kindLabel: kindLabelFor(session.name),
      };
      watched.set(session.name, state);
      continue;
    }

    state.projectName = projectNameFor(session);

    if (hash !== state.hash) {
      state.hash = hash;
      state.lastChangeAt = now;
      state.everChanged = true;
      // Inside the post-exit settle window this is the shell prompt painting
      // itself, not new work — see PUSH_EXIT_SETTLE_MS.
      if (now >= state.freezeArmUntil) state.armed = true;
    }

    /* ---- the launched tool or command exited (the sentinel line) ---- */
    if (hasSentinel && !state.sawExitSentinel) {
      state.sawExitSentinel = true;
      // Whether or not this is worth announcing, the job is over and the shell
      // prompt that follows must not later be reported as "waiting for input" —
      // that would be a second notification for an event already handled, or a
      // first one for an event judged too trivial to mention.
      state.armed = false;
      state.freezeArmUntil = now + PUSH_EXIT_SETTLE_MS;
      // A `custom` session running `echo hi` finishes before the user has put
      // the phone down; only a job that ran for a while is worth a buzz.
      if (primed && now - state.firstSeenAt >= PUSH_MIN_RUN_MS) {
        await fire(session.name, state, 'exited', { status: EXIT_SENTINEL.exec(pane)?.[1] ?? null });
        continue;
      }
    }

    /* ---- a foreground job in an interactive shell exited ---- */
    // Only meaningful for a shell the user is typing into, where job control
    // gives each command its own process group. See EXIT_SENTINEL above.
    const wasRunning = !isShell(state.command);
    const nowIdle = isShell(session.command);
    if (wasRunning && nowIdle) {
      const ranFor = now - state.commandSince;
      state.command = session.command;
      state.commandSince = now;
      if (primed && state.armed && ranFor >= PUSH_MIN_RUN_MS) {
        state.armed = false;
        state.freezeArmUntil = now + PUSH_EXIT_SETTLE_MS;
        await fire(session.name, state, 'exited', { status: null });
        continue;
      }
    } else if (session.command !== state.command) {
      state.command = session.command;
      state.commandSince = now;
    }

    /* ---- gone quiet, and the screen looks like a prompt ---- */
    if (!state.armed || !state.everChanged) continue;
    if (now - state.lastChangeAt < PUSH_QUIET_MS) continue;
    // Somebody is looking at this terminal right now. Notifying them about the
    // screen in front of them is pure noise.
    if (viewersOf(session.name) > 0) continue;
    if (!looksLikeWaiting(pane)) continue;

    state.armed = false;
    await fire(session.name, state, 'waiting');
  }

  primed = true;
}

async function fire(name, state, type, detail) {
  try {
    await notifySessionEvent({
      type,
      sessionId: `live:${name}`,
      projectName: state.projectName,
      kindLabel: state.kindLabel,
      detail,
    });
  } catch (err) {
    log.warn(`session-watch could not notify (${type} on ${name}): ${err.message}`);
  }
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

/**
 * Start the watcher.
 *
 * @param {object} opts
 * @param {(name: string) => number} opts.viewersOf  live websocket viewers of a
 *   session. Injected rather than imported so this module never depends on
 *   sessions.js, which needs to call forgetSession() here.
 */
export function startSessionWatch({ viewersOf: viewers } = {}) {
  if (timer) return;
  if (typeof viewers === 'function') viewersOf = viewers;

  let running = false;
  timer = setInterval(() => {
    // A slow tmux must not let sweeps pile up on top of each other.
    if (running) return;
    running = true;
    sweep()
      .catch((err) => log.warn(`session-watch sweep failed: ${err.message}`))
      .finally(() => {
        running = false;
      });
  }, PUSH_POLL_MS);

  if (typeof timer.unref === 'function') timer.unref();
  log.info(`session-watch polling every ${PUSH_POLL_MS}ms (quiet after ${PUSH_QUIET_MS}ms)`);
}

export function stopSessionWatch() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

/**
 * Forget a session because the user ended it deliberately.
 *
 * Killing a session from the app must not then push "session ended" to the
 * phone in the user's hand. Called from sessions.js killSession().
 */
export function forgetSession(name) {
  const state = watched.get(name);
  if (state) state.suppressed = true;
  forgetSessionState(`live:${name}`);
}
