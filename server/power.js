/**
 * Power state — the single biggest real-world reason this app goes dark.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Everything here streams from processes running on one laptop. If that laptop
 * sleeps, every PTY stops, every WebSocket dies, and the phone shows a dead
 * socket with no explanation. On this machine `pmset -g custom` reports:
 *
 *     AC Power:       sleep 0     (never sleeps — fine)
 *     Battery Power:  sleep 1     (sleeps after ONE minute of idle)
 *
 * That one-minute battery timeout silently killed a multi-day run when the lid
 * was closed on battery. The user could not tell "the Mac slept" apart from
 * "the app broke". So we read the real power state and say so, in words.
 *
 * READ-ONLY BY CONSTRUCTION
 * -------------------------
 * This module only ever runs `pmset -g …`, which needs no privileges and
 * changes nothing. It never runs `sudo`, never runs `pmset -a/-b/-c` (the
 * setting-writing forms), and never runs `caffeinate`. Deciding to keep the
 * Mac awake is the user's call; our job is to make the risk legible so they
 * can plug in.
 *
 * PARSING
 * -------
 * `pmset` prints for humans and the layout drifts between macOS releases and
 * between hardware (a Mac mini has no battery and no "Battery Power:" profile;
 * a machine with a UPS gains a third profile). So every parser here is written
 * to extract what it recognises and record what it did not, rather than to
 * assume a shape. A parse miss degrades one field to null and lands in
 * `warnings[]`; it never throws and never blocks the health route.
 */
import { execFile } from 'node:child_process';
import { log } from './util.js';

/** Absolute path: under launchd the inherited PATH is minimal, but /usr/bin is on it. */
const PMSET = '/usr/bin/pmset';

/** A pmset call that hangs must not hang the health route. */
const EXEC_TIMEOUT_MS = 2500;

/** `pmset -g assertions` is the big one; a few hundred KB is plenty. */
const MAX_BUFFER = 1 << 20;

/**
 * Power state changes on human timescales (plugging in, closing a lid), so a
 * short cache turns "every client polling every 20s" into a trickle of pmset
 * spawns without ever showing state the user would call stale.
 */
const CACHE_TTL_MS = 4000;

/** Below this, the battery itself is the deadline even if sleep is held off. */
const LOW_BATTERY_PERCENT = 20;

let cache = null;        // { at: number, value: object }
let inFlight = null;     // single-flight promise, so N clients cost one read

/* ------------------------------------------------------------------ *
 * Process plumbing
 * ------------------------------------------------------------------ */

function run(args) {
  return new Promise((resolve) => {
    execFile(
      PMSET,
      args,
      { timeout: EXEC_TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: 'utf8' },
      (err, stdout) => {
        // pmset writes usable output even when it exits non-zero on some
        // sub-queries, so take whatever text came back and note the error.
        if (err && !stdout) resolve({ ok: false, text: '', error: err.message });
        else if (err) resolve({ ok: true, text: stdout, error: err.message });
        else resolve({ ok: true, text: stdout, error: null });
      },
    );
  });
}

/* ------------------------------------------------------------------ *
 * `pmset -g ps` — which source we are on, and the battery
 * ------------------------------------------------------------------ *
 * Real output from this machine (tab before the percentage):
 *
 *   Now drawing from 'AC Power'
 *    -InternalBattery-0 (id=7012451)\t100%; charged; 0:00 remaining present: true
 *
 * On battery the middle field becomes `discharging` and the time is a real
 * estimate (`3:42 remaining`) or `(no estimate)` shortly after a source change.
 */

const BATTERY_STATES = new Set([
  'charging', 'discharging', 'charged', 'finishing charge', 'ac attached', 'not charging',
]);

export function parsePowerSource(text, warnings = []) {
  const out = { source: 'unknown', sourceLabel: null, battery: null };
  if (!text) {
    warnings.push('pmset -g ps produced no output');
    return out;
  }

  const drawing = /Now drawing from ['"]?([^'"\n]+)['"]?/i.exec(text);
  if (drawing) {
    const label = drawing[1].trim();
    out.sourceLabel = label;
    const lower = label.toLowerCase();
    if (lower.includes('ac')) out.source = 'ac';
    else if (lower.includes('battery')) out.source = 'battery';
    else if (lower.includes('ups')) out.source = 'ups';
    else warnings.push(`unrecognised power source label: ${label}`);
  } else {
    warnings.push('could not find "Now drawing from" in pmset -g ps');
  }

  // The battery line starts with a dash-prefixed device name. Whitespace
  // between the id and the percentage is a tab here but treat it as any run.
  const line = text
    .split('\n')
    .find((l) => /^\s*-\S/.test(l) && /\d+%/.test(l));

  if (line) {
    const battery = {
      present: true,
      percent: null,
      state: 'unknown',
      charging: false,
      timeRemaining: null,
      minutesRemaining: null,
    };

    const pct = /(\d{1,3})\s*%/.exec(line);
    if (pct) battery.percent = Math.min(100, Number(pct[1]));
    else warnings.push('battery line carried no percentage');

    // Fields are semicolon-separated after the percentage.
    const fields = line.split(';').map((f) => f.trim().toLowerCase());
    for (const field of fields.slice(1)) {
      const head = field.replace(/\s+present:.*$/, '').trim();
      if (BATTERY_STATES.has(head)) {
        battery.state = head;
        battery.charging = head === 'charging' || head === 'finishing charge';
        break;
      }
    }

    const time = /(\d{1,2}):(\d{2})\s+remaining/i.exec(line);
    if (time) {
      const minutes = Number(time[1]) * 60 + Number(time[2]);
      // pmset prints 0:00 both for "charged" and for "still calculating".
      if (minutes > 0) {
        battery.minutesRemaining = minutes;
        battery.timeRemaining = `${time[1]}:${time[2]}`;
      }
    }

    if (/present:\s*false/i.test(line)) battery.present = false;
    out.battery = battery;
  } else if (out.source === 'battery') {
    // Running on battery with no battery line is contradictory; say so.
    warnings.push('on battery power but pmset -g ps listed no battery');
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * `pmset -g custom` — the sleep timers, per power source
 * ------------------------------------------------------------------ *
 *   Battery Power:
 *    Sleep On Power Button 1        <- key contains spaces
 *    sleep                1         <- MINUTES of idle; 0 means never
 *    displaysleep         10
 *    hibernatefile        /var/vm/sleepimage   <- value is not a number
 *   AC Power:
 *    sleep                0
 *
 * Desktops print only "AC Power:"; a machine with a UPS gains "UPS:".
 */

/** `Battery Power:` -> `battery`, `AC Power:` -> `ac`, `UPS:` -> `ups`. */
function profileKey(header) {
  const lower = header.toLowerCase();
  if (lower.startsWith('battery')) return 'battery';
  if (lower.startsWith('ac')) return 'ac';
  if (lower.startsWith('ups')) return 'ups';
  return lower.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'other';
}

export function parseCustomSettings(text, warnings = []) {
  const profiles = {};
  if (!text) {
    warnings.push('pmset -g custom produced no output');
    return profiles;
  }

  let currentKey = null;
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;

    // A section header is unindented and ends in a colon.
    const header = /^(\S[^:]*):\s*$/.exec(raw);
    if (header && !/^\s/.test(raw)) {
      currentKey = profileKey(header[1].trim());
      profiles[currentKey] = profiles[currentKey] || { label: header[1].trim(), settings: {} };
      continue;
    }
    if (!currentKey) continue;

    // Settings are `<key with maybe spaces><whitespace><single-token value>`.
    const pair = /^\s+(.*?)\s+(\S+)\s*$/.exec(raw);
    if (!pair) continue;
    const key = pair[1].trim().toLowerCase().replace(/\s+/g, ' ');
    const rawValue = pair[2];
    const numeric = /^-?\d+$/.test(rawValue) ? Number(rawValue) : null;
    profiles[currentKey].settings[key] = numeric === null ? rawValue : numeric;
  }

  if (!Object.keys(profiles).length) {
    warnings.push('pmset -g custom parsed to zero profiles');
  }
  return profiles;
}

/* ------------------------------------------------------------------ *
 * `pmset -g assertions` — is anything holding sleep off right now
 * ------------------------------------------------------------------ *
 *   Assertion status system-wide:
 *      PreventUserIdleSystemSleep     1
 *   Listed by owning process:
 *      pid 86789(caffeinate): [0x…] 00:02:18 PreventUserIdleSystemSleep named: "caffeinate command-line tool"
 *      <TAB>Details: caffeinate asserting for 300 secs
 *      <TAB>Timeout will fire in 161 secs Action=TimeoutActionRelease
 *
 * The attribution matters more than the system-wide counters. `powerd` holds
 * "Prevent sleep while display is on" whenever the screen is awake, so the
 * system-wide PreventUserIdleSystemSleep flag reads 1 on a machine that will
 * absolutely sleep the moment the display times out. Trusting that flag would
 * produce a confidently wrong "you're safe".
 */

/**
 * Assertion types that keep the *system* awake rather than just the display.
 * `NoIdleSleepAssertion` is the legacy spelling of PreventUserIdleSystemSleep
 * and still appears from apps (Chrome uses it while playing audio);
 * `NoDisplaySleepAssertion` is display-only and deliberately absent.
 */
const SYSTEM_SLEEP_TYPES = new Set([
  'PreventUserIdleSystemSleep',
  'PreventSystemSleep',
  'NoIdleSleepAssertion',
]);

/**
 * Owners whose assertions are incidental rather than intentional. They are
 * excluded from "is sleep being held off", because reading them as protection
 * is how you get a confidently wrong "you're safe":
 *   powerd          holds one the whole time the display is on, and drops it
 *                   the moment the display times out.
 *   WindowServer    tracks the user physically touching the machine.
 *   useractivityd   BTLE/Handoff advertisement, seconds long.
 *   sharingd        Handoff, comes and goes with nearby devices.
 *   coreaudiod      lasts exactly as long as something is making noise.
 * None of them will still be there in four hours, which is the timescale that
 * matters for a long agent run.
 */
const TRANSIENT_OWNERS = new Set([
  'powerd', 'WindowServer', 'useractivityd', 'coreaudiod', 'sharingd', 'bluetoothd',
]);

export function parseAssertions(text, warnings = []) {
  const out = {
    systemWide: {},
    holders: [],
    preventingIdleSleep: false,
    preventingSystemSleep: false,
    caffeinate: { held: false, count: 0, indefinite: false, expiresInSeconds: null, holders: [] },
    heldBy: [],
    durable: { held: false, count: 0, heldBy: [] },
  };
  if (!text) {
    warnings.push('pmset -g assertions produced no output');
    return out;
  }

  const lines = text.split('\n');
  let section = null;
  let last = null;

  for (const raw of lines) {
    if (/^Assertion status system-wide:/i.test(raw)) { section = 'system'; continue; }
    if (/^Listed by owning process:/i.test(raw)) { section = 'owners'; continue; }
    if (/^Kernel Assertions:/i.test(raw)) { section = 'kernel'; continue; }

    if (section === 'system') {
      const m = /^\s+(\w+)\s+(\d+)\s*$/.exec(raw);
      if (m) out.systemWide[m[1]] = Number(m[2]);
      continue;
    }

    if (section !== 'owners') continue;

    const owner = /^\s*pid\s+(\d+)\(([^)]*)\):\s*(?:\[[^\]]*\]\s*)?(?:([\d:]+)\s+)?(\w+)\s+named:\s*(.*?)\s*$/.exec(raw);
    if (owner) {
      last = {
        pid: Number(owner[1]),
        process: owner[2],
        heldFor: owner[3] || null,
        type: owner[4],
        name: owner[5].replace(/^"|"\s*$/g, '').trim(),
        onBehalfOf: null,
        timeoutSeconds: null,
        timeoutAction: null,
      };
      out.holders.push(last);
      continue;
    }

    if (!last) continue;

    // Continuation lines are tab-indented and belong to the holder above.
    const behalf = /asserting on behalf of\s+'([^']+)'(?:\s*\(pid\s*(\d+)\))?/i.exec(raw);
    if (behalf) {
      last.onBehalfOf = behalf[2] ? `${behalf[1]} (pid ${behalf[2]})` : behalf[1];
      continue;
    }
    const timeout = /Timeout will fire in\s+(\d+)\s*secs?(?:\s+Action=(\w+))?/i.exec(raw);
    if (timeout) {
      last.timeoutSeconds = Number(timeout[1]);
      last.timeoutAction = timeout[2] || null;
    }
  }

  if (!out.holders.length && section === null) {
    warnings.push('pmset -g assertions had no recognisable sections');
  }

  // Assertions from a deliberate holder — what "sleep is being held off" means.
  const intentional = out.holders.filter(
    (a) => SYSTEM_SLEEP_TYPES.has(a.type) && !TRANSIENT_OWNERS.has(a.process),
  );
  out.preventingIdleSleep = intentional.some((a) => a.type !== 'PreventSystemSleep');
  out.preventingSystemSleep = intentional.some((a) => a.type === 'PreventSystemSleep');
  out.heldBy = [...new Set(intentional.map((a) => a.process))];

  // A hold with a timeout releases itself — `caffeinate -t 300` covers the next
  // five minutes and nothing after, so it is not protection for a long run.
  // Only an untimed hold counts as durable.
  const durableHolds = intentional.filter((a) => a.timeoutSeconds == null);
  out.durable = {
    held: durableHolds.length > 0,
    count: durableHolds.length,
    heldBy: [...new Set(durableHolds.map((a) => a.process))],
  };

  const caff = intentional.filter((a) => a.process === 'caffeinate');
  out.caffeinate.held = caff.length > 0;
  out.caffeinate.count = caff.length;
  out.caffeinate.holders = caff.map((a) => ({
    pid: a.pid,
    type: a.type,
    heldFor: a.heldFor,
    onBehalfOf: a.onBehalfOf,
    expiresInSeconds: a.timeoutSeconds,
  }));
  // "Indefinite" means at least one caffeinate assertion has no timeout — that
  // is the only kind that is still there in four hours' time.
  out.caffeinate.indefinite = caff.some((a) => a.timeoutSeconds == null);
  const timed = caff.map((a) => a.timeoutSeconds).filter((n) => typeof n === 'number');
  out.caffeinate.expiresInSeconds =
    out.caffeinate.indefinite || !timed.length ? null : Math.max(...timed);

  return out;
}

/* ------------------------------------------------------------------ *
 * Risk
 * ------------------------------------------------------------------ */

function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

/**
 * Turn the three parsed readings into one sentence a person can act on.
 * `headline` is what the phone shows in the bar; `detail` is the why;
 * `action` is the fix, which is always "plug in" — this module never fixes it.
 */
export function assessRisk({ source, battery, sleepMinutes, assertions, sleepKnown }) {
  const held = assertions?.preventingIdleSleep || assertions?.preventingSystemSleep;
  const durableHold = Boolean(assertions?.durable?.held);
  const heldBy = assertions?.durable?.heldBy?.length
    ? assertions.durable.heldBy.join(', ')
    : (assertions?.heldBy?.length ? assertions.heldBy.join(', ') : null);
  const pct = typeof battery?.percent === 'number' ? battery.percent : null;

  if (source === 'unknown' || !sleepKnown) {
    return {
      level: 'unknown',
      headline: 'Power state unknown',
      detail: 'pmset did not report a usable power state, so sleep risk cannot be assessed.',
      action: null,
    };
  }

  if (source === 'ac') {
    if (sleepMinutes === 0) {
      return {
        level: 'ok',
        headline: 'On AC power',
        detail: 'Plugged in, and idle sleep is off on AC — sessions keep running.',
        action: null,
      };
    }
    return {
      level: 'warn',
      headline: `On AC · sleeps after ${plural(sleepMinutes, 'min')} idle`,
      detail:
        `Plugged in, but this Mac is set to sleep after ${plural(sleepMinutes, 'minute')} of idle ` +
        `even on AC. Sessions drop when it does.` +
        (held ? ` Something (${heldBy || 'an assertion'}) is holding sleep off right now.` : ''),
      action: 'Set AC sleep to Never in System Settings › Battery, or keep a caffeinate running.',
    };
  }

  // ---- on battery: the case that actually bites ----
  const pctText = pct == null ? '' : ` ${pct}%`;
  const timeText = battery?.timeRemaining ? `, ~${battery.timeRemaining} left` : '';

  if (sleepMinutes === 0) {
    return {
      level: 'warn',
      headline: `On battery${pctText}`,
      detail:
        `Idle sleep is off on battery, so an idle Mac stays up — but closing the lid still ` +
        `sleeps it immediately, and the battery${timeText} is the deadline.`,
      action: 'Plug in to keep long sessions alive.',
    };
  }

  const lowBattery = pct != null && pct <= LOW_BATTERY_PERCENT;

  if (durableHold && !lowBattery) {
    return {
      level: 'warn',
      headline: `On battery${pctText} · sleep held off`,
      detail:
        `This Mac sleeps after ${plural(sleepMinutes, 'minute')} of idle on battery, but ` +
        `${heldBy || 'an assertion'} is holding that off right now. Closing the lid still sleeps ` +
        `it immediately, and the battery${timeText} still runs out.`,
      action: 'Plug in — the hold can be released at any time.',
    };
  }

  return {
    level: 'critical',
    headline: `On battery${pctText} · sleeps after ${plural(sleepMinutes, 'min')} idle`,
    detail:
      `On battery this Mac sleeps after ${plural(sleepMinutes, 'minute')} of idle, and closing ` +
      `the lid sleeps it immediately. Every session drops when that happens${timeText}.` +
      (held && !durableHold
        ? ' A short-lived sleep assertion is active but it expires on its own.'
        : ''),
    action: 'Plug the Mac in.',
  };
}

/* ------------------------------------------------------------------ *
 * Public read
 * ------------------------------------------------------------------ */

function buildPayload(psText, customText, assertText, errors, startedAt) {
  const warnings = [...errors];

  const ps = parsePowerSource(psText, warnings);
  const profiles = parseCustomSettings(customText, warnings);
  const assertions = parseAssertions(assertText, warnings);

  // The profile that governs right now. Fall back to the only profile present
  // (a desktop has just "AC Power:") rather than reporting nothing.
  const profileKeys = Object.keys(profiles);
  let activeKey = ps.source;
  if (!profiles[activeKey]) {
    activeKey = profileKeys.length === 1 ? profileKeys[0] : (profiles.ac ? 'ac' : null);
    if (activeKey && ps.source !== 'unknown') {
      warnings.push(`no "${ps.source}" profile in pmset -g custom; using "${activeKey}"`);
    }
  }
  const active = activeKey ? profiles[activeKey] : null;
  const settings = active?.settings || {};

  const sleepMinutes = typeof settings.sleep === 'number' ? settings.sleep : null;
  const sleepKnown = sleepMinutes !== null;

  const sleep = {
    profile: activeKey,
    profileLabel: active?.label || null,
    idleSleepMinutes: sleepMinutes,
    neverIdleSleeps: sleepMinutes === 0,
    displaySleepMinutes: typeof settings.displaysleep === 'number' ? settings.displaysleep : null,
    diskSleepMinutes: typeof settings.disksleep === 'number' ? settings.disksleep : null,
    lowPowerMode: settings.lowpowermode === 1,
    powerNap: settings.powernap === 1,
    wakeOnNetwork: settings.womp === 1,
    tcpKeepAlive: settings.tcpkeepalive === 1,
    hibernateMode: typeof settings.hibernatemode === 'number' ? settings.hibernatemode : null,
    /** Both profiles verbatim, so the phone can explain "…but on battery it's 1". */
    byProfile: Object.fromEntries(
      Object.entries(profiles).map(([key, p]) => [key, {
        label: p.label,
        idleSleepMinutes: typeof p.settings.sleep === 'number' ? p.settings.sleep : null,
        displaySleepMinutes:
          typeof p.settings.displaysleep === 'number' ? p.settings.displaysleep : null,
      }]),
    ),
  };

  const risk = assessRisk({
    source: ps.source,
    battery: ps.battery,
    sleepMinutes,
    assertions,
    sleepKnown,
  });

  /**
   * Seconds of idle before this Mac sleeps, as best we can tell. null means
   * "not on a timer" — either sleep is off or something durable is holding it.
   */
  const effectiveIdleSleepSeconds =
    !sleepKnown || sleepMinutes === 0 || assertions.durable.held
      ? null
      : sleepMinutes * 60;

  return {
    ok: ps.source !== 'unknown' || sleepKnown,
    source: ps.source,
    sourceLabel: ps.sourceLabel,
    onBattery: ps.source === 'battery',
    onAC: ps.source === 'ac',
    battery: ps.battery,
    sleep,
    assertions: {
      preventingIdleSleep: assertions.preventingIdleSleep,
      preventingSystemSleep: assertions.preventingSystemSleep,
      heldBy: assertions.heldBy,
      durable: assertions.durable,
      caffeinate: assertions.caffeinate,
      systemWide: assertions.systemWide,
      holders: assertions.holders,
    },
    effectiveIdleSleepSeconds,
    risk,
    warnings,
    readAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Read the current power state. Never throws — a total failure still returns a
 * payload with `ok: false` and an explanation in `warnings`, because a health
 * route that 500s because pmset moved is worse than one that says "unknown".
 *
 * @param {{force?: boolean}} [opts] `force` bypasses the 4s cache.
 */
export async function readPower({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
  if (inFlight) return inFlight;

  const startedAt = Date.now();
  inFlight = (async () => {
    const [ps, custom, assertions] = await Promise.all([
      run(['-g', 'ps']),
      run(['-g', 'custom']),
      run(['-g', 'assertions']),
    ]);

    const errors = [];
    if (!ps.ok) errors.push(`pmset -g ps failed: ${ps.error}`);
    if (!custom.ok) errors.push(`pmset -g custom failed: ${custom.error}`);
    if (!assertions.ok) errors.push(`pmset -g assertions failed: ${assertions.error}`);

    let value;
    try {
      value = buildPayload(ps.text, custom.text, assertions.text, errors, startedAt);
    } catch (err) {
      log.warn('power: parse failed', err);
      value = {
        ok: false,
        source: 'unknown',
        sourceLabel: null,
        onBattery: false,
        onAC: false,
        battery: null,
        sleep: null,
        assertions: null,
        effectiveIdleSleepSeconds: null,
        risk: {
          level: 'unknown',
          headline: 'Power state unavailable',
          detail: `Could not read pmset: ${err.message}`,
          action: null,
        },
        warnings: [...errors, `parse error: ${err.message}`],
        readAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
      };
    }

    cache = { at: Date.now(), value };
    return value;
  })().finally(() => { inFlight = null; });

  return inFlight;
}

/** One line for a terminal: `on battery 87% — sleeps after 1 min idle`. */
export function describePower(power) {
  if (!power) return 'power: unknown';
  const bits = [power.risk?.headline || power.sourceLabel || 'unknown'];
  if (power.assertions?.caffeinate?.held) {
    const c = power.assertions.caffeinate;
    bits.push(c.indefinite
      ? 'caffeinate held (no timeout)'
      : `caffeinate held (${c.expiresInSeconds}s left)`);
  }
  return bits.join(' · ');
}
