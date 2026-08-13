/**
 * Modal dialogs blocking the Mac.
 *
 * The failure this exists for: something is waiting on a click nobody is there
 * to give, and from the phone it is invisible. A restart is the worst case —
 * "reopen your windows?", an app that quit unexpectedly, a save prompt — but it
 * happens during any long unattended run too.
 *
 * What cannot be answered from here is documented in scripts/dialogs.js: the
 * login window (nothing of ours is running yet) and TCC permission prompts
 * (unclickable by design, below SIP). Those are surfaced, not solved.
 */

import path from 'node:path';
import { execFile } from 'node:child_process';
import { PROJECT_ROOT } from './config.js';
import { log } from './util.js';

const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'dialogs.js');

function run(args, timeout = 20_000) {
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', SCRIPT, ...args],
      { timeout, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          log.debug(`dialogs helper failed: ${err.message}`);
          return resolve({ ok: false, error: err.message });
        }
        try { resolve(JSON.parse(stdout)); }
        catch { resolve({ ok: false, error: 'helper returned non-JSON' }); }
      });
  });
}

/**
 * Scanning every process's windows takes ~1s, which is far too slow to sit in
 * the path of a routine poll, so a result is shared for a few seconds.
 */
const CACHE_MS = 5000;
let cache = { at: 0, value: [] };
let inFlight = null;

export async function listDialogs({ force = false } = {}) {
  if (!force && Date.now() - cache.at < CACHE_MS) return cache.value;
  if (inFlight) return inFlight;
  inFlight = run(['list'])
    .then((r) => {
      const dialogs = r.ok && Array.isArray(r.dialogs) ? r.dialogs : [];
      cache = { at: Date.now(), value: dialogs };
      return dialogs;
    })
    .finally(() => { inFlight = null; });
  return inFlight;
}

export async function clickDialog({ app, window = '', button }) {
  const r = await run(['click', app, window, button]);
  cache = { at: 0, value: cache.value };   // the screen just changed
  return r;
}
