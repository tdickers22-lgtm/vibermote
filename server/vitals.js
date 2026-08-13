/**
 * Is the Mac healthy, struggling, or gone?
 *
 * ┌─ THE LIMIT THIS MODULE CANNOT CROSS ───────────────────────────────────┐
 * │ If the Mac truly freezes or panics, this server freezes with it. It    │
 * │ cannot report its own death. Everything here detects DEGRADATION —     │
 * │ load, memory pressure, a wedged window server — while the machine is   │
 * │ still alive enough to answer.                                          │
 * │                                                                        │
 * │ Detecting death is the phone's job: the client watches how long it has │
 * │ been since it last heard anything. Recovering from death is macOS's    │
 * │ job, and needs two settings that only the user can turn on (see        │
 * │ /api/vitals -> recovery). No code here can substitute for either.      │
 * └────────────────────────────────────────────────────────────────────────┘
 */

import os from 'node:os';
import { execFile } from 'node:child_process';
import { readPower } from './power.js';
import { log } from './util.js';

function sh(cmd, args, timeout = 4000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}

/**
 * Real free memory on macOS.
 *
 * `os.freemem()` reads near-zero on a perfectly healthy Mac, because macOS
 * keeps everything it can in the file cache. Anything auto-tuning on that value
 * clamps itself to nothing. The honest figure is free + inactive + speculative
 * + purgeable, which is what the system will hand back under pressure.
 */
async function memory() {
  const out = await sh('/usr/bin/vm_stat', []);
  if (!out) return null;
  const pageSize = Number((out.match(/page size of (\d+) bytes/) || [])[1] || 4096);
  const val = (label) => {
    const m = out.match(new RegExp(`${label}:\\s+(\\d+)`));
    return m ? Number(m[1]) * pageSize : 0;
  };
  const free = val('Pages free') + val('Pages inactive')
             + val('Pages speculative') + val('Pages purgeable');
  const total = os.totalmem();
  // Swap-ins under pressure are the signal that matters more than the gauge:
  // a Mac that is swapping is already slow no matter what the numbers say.
  const compressed = val('Pages occupied by compressor');
  return {
    total,
    available: free,
    usedPct: Math.max(0, Math.min(100, Math.round((1 - free / total) * 100))),
    compressed,
  };
}

/** Thermal throttling, when the platform reports it at all. */
async function thermal() {
  const out = await sh('/usr/bin/pmset', ['-g', 'therm']);
  if (!out) return null;
  const speed = (out.match(/CPU_Speed_Limit\s*=\s*(\d+)/) || [])[1];
  return speed === undefined ? null : { cpuSpeedLimit: Number(speed) };
}

/** Is anything holding sleep off? If not, the Mac can vanish mid-job. */
async function sleepHeld() {
  const out = await sh('/usr/bin/pmset', ['-g']);
  const m = out.match(/sleep\s+\d+\s*\(sleep prevented by ([^)]*)\)/i);
  return { prevented: Boolean(m), by: m ? m[1].split(/,\s*/).filter(Boolean) : [] };
}

/**
 * The two macOS settings that decide whether a frozen Mac can come back on its
 * own. Both are reported rather than changed: one needs sudo and the other is a
 * security decision that is not a program's to make.
 */
async function recovery() {
  const [freeze, autoUser, fv] = await Promise.all([
    sh('/usr/sbin/systemsetup', ['-getrestartfreeze']),
    sh('/usr/bin/defaults', ['read', '/Library/Preferences/com.apple.loginwindow', 'autoLoginUser']),
    sh('/usr/bin/fdesetup', ['status']),
  ]);
  const restartOnFreeze = /on\b/i.test(freeze) ? true : (/off\b/i.test(freeze) ? false : null);
  const autoLogin = autoUser.trim() ? autoUser.trim() : null;
  const fileVault = /is On/i.test(fv) ? true : (/is Off/i.test(fv) ? false : null);
  return {
    restartOnFreeze,          // null = needs sudo to read
    autoLogin,                // null = off; a frozen Mac reboots to the login window
    fileVault,                // on => auto-login impossible at all
    // Unattended recovery needs the Mac to restart itself AND get back to a
    // logged-in GUI session, because this server runs as a LaunchAgent and
    // LaunchAgents do not exist until someone logs in.
    unattended: Boolean(restartOnFreeze) && Boolean(autoLogin),
  };
}

/**
 * Overall verdict. Deliberately coarse: the point is "should I start another
 * agent right now", not a monitoring dashboard.
 */
function verdict({ load, cores, mem, thermalInfo }) {
  const perCore = load / (cores || 1);
  if (perCore >= 2 || (mem && mem.usedPct >= 95)) return 'critical';
  if (perCore >= 1 || (mem && mem.usedPct >= 85)
      || (thermalInfo && thermalInfo.cpuSpeedLimit < 100)) return 'busy';
  return 'ok';
}

/**
 * readPower() returns a very large diagnostic object — every sleep assertion on
 * the machine, with holders. That is the right level of detail for its own
 * screen and the wrong thing to ship to a phone polling every few seconds, so
 * only the parts that change a decision survive.
 */
function trimPower(power) {
  if (!power || !power.ok) return null;
  return {
    source: power.source,
    onBattery: power.onBattery,
    percent: power.battery?.percent ?? null,
    charging: power.battery?.charging ?? false,
    timeRemaining: power.battery?.timeRemaining ?? null,
    sleepHeld: Boolean(power.assertions?.preventingIdleSleep),
    risk: power.risk?.level ?? null,
    riskHeadline: power.risk?.headline ?? null,
  };
}

/**
 * One reading costs six subprocesses (vm_stat, pmset twice, systemsetup,
 * defaults, fdesetup) plus readPower's own work. None of it changes
 * meaningfully second to second, and the whole point of this module is to avoid
 * loading the machine, so a reading is shared for a few seconds and concurrent
 * callers wait on the same promise instead of each spawning their own.
 */
const VITALS_CACHE_MS = 8000;
let vitalsCache = { at: 0, value: null };
let vitalsInFlight = null;

export async function readVitals({ terminalOk = null, force = false } = {}) {
  const now = Date.now();
  if (!force && vitalsCache.value && now - vitalsCache.at < VITALS_CACHE_MS) {
    return { ...vitalsCache.value, terminalResponsive: terminalOk };
  }
  if (vitalsInFlight) {
    const v = await vitalsInFlight;
    return { ...v, terminalResponsive: terminalOk };
  }
  vitalsInFlight = readVitalsUncached({ terminalOk })
    .then((v) => { vitalsCache = { at: Date.now(), value: v }; return v; })
    .finally(() => { vitalsInFlight = null; });
  return vitalsInFlight;
}

async function readVitalsUncached({ terminalOk = null } = {}) {
  const [mem, thermalInfo, sleep, rec, power] = await Promise.all([
    memory().catch(() => null),
    thermal().catch(() => null),
    sleepHeld().catch(() => ({ prevented: false, by: [] })),
    recovery().catch(() => ({})),
    Promise.resolve().then(() => readPower()).catch(() => null),
  ]);

  const cores = os.cpus().length;
  const [load1, load5, load15] = os.loadavg();

  return {
    at: Date.now(),
    uptime: os.uptime(),
    cpu: { cores, load1, load5, load15, perCore: load1 / (cores || 1) },
    memory: mem,
    thermal: thermalInfo,
    sleep,
    power: trimPower(power),
    recovery: rec,
    // Whether Terminal answered its last Apple Event. A wedged window server
    // still lets HTTP through, so this is the closest thing to "the GUI is
    // frozen" that a process inside the machine can observe.
    terminalResponsive: terminalOk,
    state: verdict({ load: load1, cores, mem, thermalInfo }),
  };
}

/**
 * Restart the Mac.
 *
 * Goes through loginwindow rather than `shutdown`, so it needs no sudo and
 * behaves like choosing Restart from the Apple menu — including being refused
 * by an app with unsaved changes, which is why the caller must report the
 * outcome rather than assume it worked.
 */
export async function restartMac() {
  const out = await sh('/usr/bin/osascript',
    ['-e', 'tell application "System Events" to restart'], 15_000);
  log.warn('restart requested from the API');
  return { ok: true, note: 'Restart requested. An app with unsaved work can still block it.', out: out.trim() };
}
