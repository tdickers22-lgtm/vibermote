/**
 * The unified session list the phone renders — "all my terminal windows".
 *
 * Merges two very different sources into one sorted list with stable ids:
 *   - live tmux sessions we manage (prefix-filtered, so the user's own tmux
 *     sessions are invisible to this server)
 *   - dormant, resumable sessions discovered per kind (Claude transcripts,
 *     Codex rollouts, and whatever a future registry entry adds)
 *
 * Every row carries its `kind`, so the client renders one list with per-tool
 * badges rather than one list per tool. A session resumed from a dormant
 * record appears once, as the live row.
 *
 * ID FORMAT
 *   live:<tmux-session-name>            e.g. live:ccr-codex-movievault
 *   dormant:<kind>:<ref>                e.g. dormant:codex:019fed38-…
 *                                            dormant:claude:-Users-tobias-x/uuid
 * `ref` is opaque to the client and defined by the kind's `refFor`.
 */
import path from 'node:path';
import * as tmuxApi from './tmux.js';
import { peekBroker } from './sessions.js';
import { getMeta, pruneMeta } from './meta.js';
import { TMUX_PREFIX } from './config.js';
import { KINDS, DEFAULT_KIND, getKind, discoverAllDormant, kindFromTmuxName } from './kinds.js';

export const ID = {
  live: (tmuxName) => `live:${tmuxName}`,
  dormant: (kindId, ref) => `dormant:${kindId}:${ref}`,
};

/**
 * Parse an id back into its parts.
 * @returns {{status:'live', tmuxName:string}
 *          |{status:'dormant', kind:string, ref:string}
 *          |null}
 */
export function parseId(id) {
  if (typeof id !== 'string' || id.length > 512) return null;

  if (id.startsWith('live:')) {
    const tmuxName = id.slice(5);
    if (!tmuxName.startsWith(TMUX_PREFIX)) return null; // never address a foreign session
    if (tmuxName.includes('/') || tmuxName.includes(':')) return null;
    return { status: 'live', tmuxName };
  }

  if (id.startsWith('dormant:')) {
    const rest = id.slice(8);
    if (!rest) return null;

    const colon = rest.indexOf(':');
    let kind = colon > 0 ? rest.slice(0, colon) : null;
    let ref = colon > 0 ? rest.slice(colon + 1) : rest;

    // Legacy form `dormant:<projectDirName>/<uuid>` predates kinds and always
    // meant Claude. Accepted so an old bookmark still resolves.
    if (!getKind(kind)) {
      kind = 'claude';
      ref = rest;
    }

    if (!ref) return null;
    // The ref reaches a lookup, not a filesystem join, but reject traversal
    // anyway so it can never be repurposed into a path.
    if (ref.includes('..') || ref.startsWith('/') || ref.includes('\0')) return null;

    return { status: 'dormant', kind, ref };
  }

  return null;
}

function labelForLive(session, meta, kindId) {
  if (meta?.label) return meta.label;
  const dir = session.cwd || meta?.projectDir;
  if (dir) return path.basename(dir.replace(/\/+$/, '')) || dir;
  const rest = session.name.slice(TMUX_PREFIX.length);
  return rest.startsWith(`${kindId}-`) ? rest.slice(kindId.length + 1) : rest || session.name;
}

/** UI hints attached to every row so the client never needs its own kind table. */
function kindFacts(kindId) {
  const kind = KINDS[kindId] || KINDS[DEFAULT_KIND];
  return {
    kind: kind.id,
    kindLabel: kind.displayName,
    icon: kind.icon,
    glyph: kind.glyph,
    color: kind.color,
  };
}

/**
 * The unified list: live tmux sessions plus dormant resumable ones across all
 * kinds, most recently active first.
 *
 * @returns {Promise<Array<object>>}
 */
export async function listAllSessions() {
  const [liveListing, dormant] = await Promise.all([tmuxApi.listSessions(), discoverAllDormant()]);
  const live = liveListing.sessions;

  // Only prune when tmux actually answered. `ok:false` means the query failed,
  // and pruning against a list we could not verify would delete the metadata of
  // sessions that are still running — the exact failure documented in tmux.js.
  if (liveListing.ok) pruneMeta(live.map((s) => s.name));

  // A dormant record already open in a live session is not a separate row.
  const resumed = new Set();

  const liveEntries = live.map((s) => {
    const meta = getMeta(s.name);
    // Name first: it survives losing .sessions.json, which meta does not.
    const kindId = kindFromTmuxName(s.name) || meta?.kind || DEFAULT_KIND;
    if (meta?.resumedFrom) resumed.add(`${kindId}:${meta.resumedFrom}`);

    const broker = peekBroker(s.name);
    return {
      id: ID.live(s.name),
      status: 'live',
      ...kindFacts(kindId),
      label: labelForLive(s, meta, kindId),
      projectDir: s.cwd || meta?.projectDir || null,
      gitBranch: null,
      preview: meta?.preview || '',
      lastActivity: s.activityAt || s.createdAt || Date.now(),
      resumeId: meta?.resumedFrom || null,
      live: {
        tmuxName: s.name,
        attachedClients: s.attachedClients,
        windows: s.windows,
        cols: s.cols,
        rows: s.rows,
        createdAt: s.createdAt,
        command: s.command,
        subscribers: broker ? broker.subscribers.size : 0,
        hasPty: Boolean(broker && broker.pty),
      },
      dormant: null,
    };
  });

  const dormantEntries = dormant
    .filter((d) => !resumed.has(`${d.kind}:${d.resumeId}`))
    .map((d) => ({
      id: ID.dormant(d.kind, d.ref),
      status: 'dormant',
      ...kindFacts(d.kind),
      label: d.label,
      projectDir: d.projectDir,
      gitBranch: d.gitBranch || null,
      preview: d.preview,
      lastActivity: d.lastActivity,
      resumeId: d.resumeId,
      live: null,
      dormant: {
        sessionId: d.sessionId,
        title: d.title,
        sizeBytes: d.sizeBytes,
        file: d.file,
      },
    }));

  return [...liveEntries, ...dormantEntries].sort((a, b) => b.lastActivity - a.lastActivity);
}

/** Look up one entry by id. */
export async function findSession(id) {
  const all = await listAllSessions();
  return all.find((s) => s.id === id) || null;
}

/**
 * Distinct project directories across every kind, most recently active first —
 * for the "new session" directory picker.
 */
export async function listProjects() {
  const dormant = await discoverAllDormant();
  const byDir = new Map();

  for (const d of dormant) {
    if (!d.projectDir) continue;
    const e = byDir.get(d.projectDir) || {
      projectDir: d.projectDir,
      name: path.basename(d.projectDir.replace(/\/+$/, '')) || d.projectDir,
      lastActivity: 0,
      sessions: 0,
      kinds: new Set(),
    };
    e.lastActivity = Math.max(e.lastActivity, d.lastActivity);
    e.sessions += 1;
    e.kinds.add(d.kind);
    byDir.set(d.projectDir, e);
  }

  return [...byDir.values()]
    .map((e) => ({ ...e, kinds: [...e.kinds] }))
    .sort((a, b) => b.lastActivity - a.lastActivity);
}
