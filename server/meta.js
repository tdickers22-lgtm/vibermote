/**
 * Small persistent registry of metadata about sessions *we* created.
 *
 * tmux knows a session's name and cwd but not which Claude transcript it was
 * resumed from. Persisting that lets the unified list show one row for a
 * resumed session instead of a live row and a stale dormant row side by side,
 * and it survives a server restart while the tmux sessions keep running.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from './config.js';
import { log } from './util.js';

const META_PATH = path.join(PROJECT_ROOT, '.sessions.json');

/** tmux name -> { projectDir, resumedFrom, args, label, createdAt } */
let store = new Map();
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = fs.readFileSync(META_PATH, 'utf8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') store = new Map(Object.entries(obj));
  } catch (err) {
    if (err.code !== 'ENOENT') log.debug(`session metadata unreadable: ${err.message}`);
  }
}

function persist() {
  try {
    const obj = Object.fromEntries(store);
    fs.writeFileSync(META_PATH, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 });
  } catch (err) {
    log.warn(`could not persist session metadata: ${err.message}`);
  }
}

export function setMeta(name, data) {
  load();
  store.set(name, { ...(store.get(name) || {}), ...data });
  persist();
}

export function getMeta(name) {
  load();
  return store.get(name) || null;
}

export function deleteMeta(name) {
  load();
  if (store.delete(name)) persist();
}

/** Forget metadata for sessions tmux no longer has, so the file cannot grow forever. */
export function pruneMeta(liveNames) {
  load();
  const alive = new Set(liveNames);
  let changed = false;
  for (const key of [...store.keys()]) {
    if (!alive.has(key)) {
      store.delete(key);
      changed = true;
    }
  }
  if (changed) persist();
}
