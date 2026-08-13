/**
 * Terminal.app mirror — a read-only third session source.
 *
 * Vibermote's own sessions are tmux sessions it started, and it can attach to
 * those over a PTY. This module covers the terminals that were already open
 * before Vibermote was involved: an agent running under a plain login shell,
 * with no tmux in the chain. Nothing outside the machine can attach to those,
 * but Terminal will report what is on their screen, so they can at least be
 * mirrored to the phone instead of being invisible.
 *
 * Read-only is a property of the situation, not a decision: a process's
 * controlling terminal cannot be handed to another program after the fact, and
 * macOS has no `reptyr`. Anything you want to drive from the phone has to be
 * started inside tmux in the first place.
 */

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { PROJECT_ROOT } from './config.js';
import { looksLikeWaiting } from './waiting.js';
import { log } from './util.js';

const SNAPSHOT = path.join(PROJECT_ROOT, 'scripts', 'terminal-snapshot.js');
const INPUT = path.join(PROJECT_ROOT, 'scripts', 'terminal-input.js');
const OPEN = path.join(PROJECT_ROOT, 'scripts', 'terminal-open.js');

/** Run one of the osascript helpers and parse its JSON reply. */
function runScript(file, args, timeout = 15_000) {
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript',
      ['-l', 'JavaScript', file, ...args.map(String)],
      { timeout, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve({ ok: false, error: err.message });
        try { resolve(JSON.parse(stdout)); }
        catch { resolve({ ok: false, error: 'helper returned non-JSON' }); }
      });
  });
}

/**
 * Type into a Terminal window.
 *
 * `mode` is 'text' (optionally submitted with Return) or 'key' for a named key
 * or control combination. This focuses the window on the Mac before typing —
 * unavoidable, see scripts/terminal-input.js — so it steals focus from whatever
 * the Mac was doing. The cache is dropped afterwards so the next poll shows the
 * result rather than a snapshot taken before the keystrokes landed.
 */
export async function sendInput({ windowId, mode = 'text', payload = '', submit = false }) {
  const args = [windowId, mode, payload];
  if (mode === 'text' && submit) args.push('submit');
  const result = await runScript(INPUT, args);
  cached = { at: 0, windows: cached.windows };
  return result;
}

/** Open a new Terminal window on the Mac, optionally in a directory / running a command. */
export async function openWindow({ cwd = '', command = '' } = {}) {
  const result = await runScript(OPEN, [cwd, command], 20_000);
  cached = { at: 0, windows: cached.windows };
  return result;
}

/**
 * One osascript run costs ~400ms, most of it interpreter startup and the lsof
 * that resolves working directories. Several phones polling the wall must not
 * multiply that, so a snapshot is shared for a beat and concurrent callers wait
 * on the same promise rather than each spawning their own.
 */
const CACHE_MS = 2000;
let cached = { at: 0, windows: [] };
let inFlight = null;

function runSnapshot(extra = []) {
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', SNAPSHOT, ...extra],
      { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          log.debug('terminal snapshot failed:', err.message);
          return resolve([]);
        }
        try {
          const parsed = JSON.parse(stdout);
          if (!parsed.ok) {
            log.debug('terminal snapshot error:', parsed.error);
            return resolve([]);
          }
          resolve(Array.isArray(parsed.windows) ? parsed.windows : []);
        } catch (e) {
          log.debug('terminal snapshot returned non-JSON:', e.message);
          resolve([]);
        }
      }
    );
  });
}

/* ------------------------------------------------------ what is it doing? */

/** How long a screen must sit still before stillness means anything. */
const QUIET_MS = 45_000;
/**
 * If nothing sampled this window for longer than this, stillness cannot be
 * inferred: we simply were not watching. The clock restarts rather than
 * claiming a window has been quiet for the whole gap, which would announce
 * "waiting for you" the instant you opened the app.
 */
const STALE_MS = 20_000;

/** window id -> { hash, changedAt, seenAt, state } */
const states = new Map();

function classify(windows) {
  const now = Date.now();
  const seen = new Set();
  for (const w of windows) {
    seen.add(w.id);
    const screen = w.screen || '';
    const hash = crypto.createHash('sha1').update(screen).digest('base64');
    const prev = states.get(w.id);

    let changedAt = now;
    if (prev && now - prev.seenAt <= STALE_MS && prev.hash === hash) {
      changedAt = prev.changedAt;                 // unchanged since we last looked
    }

    const stillFor = now - changedAt;
    // 'working' until proven otherwise. Being wrong in this direction costs
    // nothing; the opposite trains you to ignore the badge.
    let state = 'working';
    if (stillFor >= QUIET_MS) state = looksLikeWaiting(screen) ? 'waiting' : 'idle';

    states.set(w.id, { hash, changedAt, seenAt: now, state });
    w.state = state;
    w.stillFor = stillFor;
  }
  for (const id of [...states.keys()]) if (!seen.has(id)) states.delete(id);
  return windows;
}

export async function snapshotWindows({ force = false, light = false } = {}) {
  // A light snapshot has no cwd or process chain, so it must never land in the
  // cache the API serves from. It exists purely to keep the state machine fed.
  if (light) return classify(await runSnapshot(['light']));

  const now = Date.now();
  if (!force && now - cached.at < CACHE_MS) return cached.windows;
  if (inFlight) return inFlight;
  inFlight = runSnapshot()
    .then((windows) => {
      classify(windows);
      cached = { at: Date.now(), windows };
      return windows;
    })
    .finally(() => { inFlight = null; });
  return inFlight;
}

/* --------------------------------------------------------------- ordering */

/**
 * Order is the whole point of the wall, so it is defined once, here.
 *
 * Project first, so everything belonging to one checkout is contiguous and a
 * dev server ends up beside the agent that needs it. Then CLI, so the claudes
 * sit together. Bare shells trail their own project rather than collecting in
 * one lump at the end, because a shell opened in a repo is nearly always doing
 * something for that repo. Loose home-directory work sorts last.
 *
 * termtile applies the same rule to the windows on the Mac, so the order you
 * scroll through on the phone matches the order they are tiled in on screen.
 */
function rank(w) {
  return [
    w.project ? 0 : 1,          // real projects before loose home-directory work
    w.project || '',
    w.cli ? 0 : 1,              // a project's tools before that project's shells
    w.cli || ''
  ];
}

function compare(a, b) {
  const ra = rank(a), rb = rank(b);
  for (let i = 0; i < ra.length; i++) {
    if (ra[i] < rb[i]) return -1;
    if (ra[i] > rb[i]) return 1;
  }
  return a.id - b.id;            // stable when two windows are otherwise equal
}

export function groupLabel(w) {
  const project = w.project || '~';
  return w.cli ? `${project} / ${w.cli}` : `${project} / shell`;
}

/**
 * The wall's payload: every Terminal window, ordered, each carrying the text
 * currently on its screen.
 */
export async function listTerminalWindows({ force = false } = {}) {
  const windows = await snapshotWindows({ force });
  return [...windows].sort(compare).map((w) => ({
    id: `term:${w.id}`,
    windowId: w.id,
    source: 'terminal',
    status: 'mirror',        // live, but attach is impossible — see the note above
    attachable: false,
    title: w.title,
    label: shortTitle(w),
    group: groupLabel(w),
    project: w.project,
    cli: w.cli,
    cwd: w.cwd,
    minimized: w.minimized,
    state: w.state || 'working',   // working | waiting | idle
    stillFor: w.stillFor || 0,
    screen: w.screen
  }));
}

/**
 * Terminal's window title is "<dir> — <task> — <process chain> — <cols>x<rows>".
 * The task is the useful part on a phone-sized card; the rest is already shown
 * by the group heading or is noise.
 */
function shortTitle(w) {
  const parts = String(w.title || '').split('—').map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) return parts[1];
  return parts[0] || (w.cli || 'shell');
}
