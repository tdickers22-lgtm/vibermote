/**
 * Hold sleep off, from the phone.
 *
 * A sleeping Mac is indistinguishable from a dead one at this end: the network
 * stack is down, so Tailscale is down, so nothing here is reachable. And it
 * cannot be woken back over the tailnet, because reaching the tailnet is
 * exactly what it can no longer do. Wake-on-LAN needs a magic packet from a
 * device on the same physical network, which a phone on cellular is not.
 *
 * So sleep is not a thing to recover from, it is a thing to prevent. This wraps
 * `caffeinate`, which holds an IOKit power assertion for as long as it runs.
 */

import { spawn } from 'node:child_process';
import { log } from './util.js';

let held = null;   // { proc, until, seconds }

export function awakeStatus() {
  if (!held) return { holding: false, until: null, secondsLeft: 0 };
  const secondsLeft = Math.max(0, Math.round((held.until - Date.now()) / 1000));
  return { holding: true, until: held.until, secondsLeft, pid: held.proc.pid };
}

export function releaseAwake() {
  if (!held) return { ok: true, holding: false };
  try { held.proc.kill('SIGTERM'); } catch { /* already gone */ }
  held = null;
  log.info('sleep hold released');
  return { ok: true, holding: false };
}

/**
 * `-d` display, `-i` idle system, `-m` disk, `-s` system. Deliberately NOT `-u`
 * (which only simulates user activity): the point is to survive being left
 * alone, not to look busy for a moment.
 *
 * Always bounded. An unbounded hold left running by accident is how a laptop in
 * a bag cooks itself, so the timeout is the default rather than the exception.
 */
export function holdAwake({ seconds = 3600 } = {}) {
  const s = Math.max(60, Math.min(Number(seconds) || 3600, 12 * 3600));
  releaseAwake();
  const proc = spawn('/usr/bin/caffeinate', ['-dims', '-t', String(s)], {
    detached: false,
    stdio: 'ignore',
  });
  held = { proc, until: Date.now() + s * 1000, seconds: s };
  proc.on('exit', () => { if (held && held.proc === proc) held = null; });
  log.info(`holding sleep off for ${s}s`);
  return { ok: true, ...awakeStatus() };
}
