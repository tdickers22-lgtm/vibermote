/**
 * THE SESSION-KIND REGISTRY.
 *
 * One declarative entry per kind of terminal session this server can run.
 * Adding a new tool means adding one object to KINDS below — nothing else in
 * the server needs to learn about it. Everything downstream (discovery, the
 * unified list, launching, the HTTP API, the UI hints the client renders) is
 * driven off these entries.
 *
 * Each entry declares:
 *   id            stable identifier, used in ids and on the wire
 *   displayName   human label
 *   bin           binary name, for $PATH lookup and error messages
 *   binCandidates absolute paths tried before falling back to $PATH
 *   envVar        environment override for the binary's absolute path
 *   icon/glyph/color   UI hints for the client
 *   launchArgv    argv for a fresh session
 *   resumeArgv    argv to resume a prior session (null when unsupported)
 *   isResumeId    validator — this string reaches a command line
 *   discover      lists dormant resumable sessions (null when unsupported)
 *   refFor        builds the opaque ref used in a dormant session id
 */
import path from 'node:path';
import {
  HOME,
  LOGIN_SHELL,
  TMUX_PREFIX,
  HARDENED_PATH,
  firstExisting,
  findOnHardenedPath,
} from './config.js';
import { listDormantSessions } from './transcripts.js';
import { listDormantCodexSessions, isCodexSessionId } from './codex-sessions.js';
import { shQuote } from './util.js';

/** Loose id: UUIDs plus the odd named session. Reaches a command line, so no shell metacharacters. */
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** Longest command line accepted for a `custom` session. */
export const MAX_COMMAND_LENGTH = 4096;

/**
 * Coerce whatever reached an argv builder into a string array.
 *
 * The HTTP layer already rejects a non-array `args` with a clear 400, but
 * `createSession()` is an exported function and a `= []` parameter default only
 * fires for `undefined` — `null`, a bare string or a number would sail past it
 * and blow up on `.map`. A lone string is the one shape worth accepting rather
 * than dropping; anything else is not an argument and is discarded, because
 * stringifying an object into "[object Object]" and handing that to a shell is
 * worse than ignoring it.
 */
function argList(args) {
  if (Array.isArray(args)) return args.filter((a) => typeof a === 'string');
  if (typeof args === 'string' && args) return [args];
  return [];
}

export const KINDS = {
  claude: {
    id: 'claude',
    displayName: 'Claude Code',
    bin: 'claude',
    envVar: 'CCR_CLAUDE',
    binCandidates: [
      path.join(HOME, '.local', 'bin', 'claude'),
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
    ],
    icon: '✳',
    glyph: 'CC',
    color: '#d97757',
    launchArgv: ({ args }) => argList(args),
    resumeArgv: ({ sessionId, args }) => ['--resume', sessionId, ...argList(args)],
    isResumeId: (id) => SAFE_ID.test(id),
    refFor: (entry) => `${entry.projectDirName}/${entry.sessionId}`,
    discover: async () => {
      const rows = await listDormantSessions();
      return rows.map((r) => ({
        kind: 'claude',
        sessionId: r.sessionId,
        resumeId: r.sessionId,
        ref: `${r.projectDirName}/${r.sessionId}`,
        projectDir: r.projectDir,
        projectDirName: r.projectDirName,
        gitBranch: r.gitBranch,
        title: r.title,
        label: r.label,
        preview: r.preview,
        lastActivity: r.lastActivity,
        sizeBytes: r.sizeBytes,
        file: r.file,
      }));
    },
  },

  codex: {
    id: 'codex',
    displayName: 'Codex',
    bin: 'codex',
    envVar: 'CCR_CODEX',
    binCandidates: [
      path.join(HOME, '.nvm', 'versions', 'node', 'v20.20.0', 'bin', 'codex'),
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
    ],
    icon: '◇',
    glyph: 'CX',
    color: '#10a37f',
    launchArgv: ({ args }) => argList(args),
    // `codex resume <SESSION_ID>` takes the rollout UUID directly, so the
    // picker is bypassed entirely and the phone lands in the right session.
    resumeArgv: ({ sessionId, args }) => ['resume', sessionId, ...argList(args)],
    isResumeId: (id) => isCodexSessionId(id),
    refFor: (entry) => entry.sessionId,
    discover: async () => {
      const rows = await listDormantCodexSessions();
      return rows.map((r) => ({
        kind: 'codex',
        sessionId: r.sessionId,
        resumeId: r.sessionId,
        ref: r.sessionId,
        projectDir: r.projectDir,
        projectDirName: null,
        gitBranch: r.gitBranch,
        title: r.title,
        label: r.label,
        preview: r.preview,
        lastActivity: r.lastActivity,
        sizeBytes: r.sizeBytes,
        file: r.file,
      }));
    },
  },

  opencode: {
    id: 'opencode',
    displayName: 'opencode',
    bin: 'opencode',
    envVar: 'CCR_OPENCODE',
    binCandidates: [
      path.join(HOME, '.opencode', 'bin', 'opencode'),
      '/opt/homebrew/bin/opencode',
      '/usr/local/bin/opencode',
    ],
    icon: '◆',
    glyph: 'OC',
    color: '#6c7ce0',
    launchArgv: ({ args }) => argList(args),
    // `-s/--session <id>` resumes a known session id. Listing those ids would
    // mean reading opencode's own database, which is not worth a dependency —
    // so opencode is launch-only in the unified list, and resume works when the
    // caller already knows an id.
    resumeArgv: ({ sessionId, args }) => ['--session', sessionId, ...argList(args)],
    isResumeId: (id) => SAFE_ID.test(id),
    refFor: (entry) => entry.sessionId,
    discover: null,
  },

  'cursor-agent': {
    id: 'cursor-agent',
    displayName: 'Cursor',
    bin: 'cursor-agent',
    envVar: 'CCR_CURSOR_AGENT',
    // The installer symlinks both names into ~/.local/bin. `agent` is the one it
    // advertises, but that name is generic enough to collide, so the specific
    // symlink is preferred and `agent` is only a fallback.
    binCandidates: [
      path.join(HOME, '.local', 'bin', 'cursor-agent'),
      path.join(HOME, '.local', 'bin', 'agent'),
      '/opt/homebrew/bin/cursor-agent',
      '/usr/local/bin/cursor-agent',
    ],
    icon: '▲',
    glyph: 'CU',
    color: '#8b5cf6',
    // --force is Cursor's --dangerously-skip-permissions ("Force allow commands
    // unless explicitly denied"); --trust skips the per-directory trust gate that
    // otherwise stops the first run in any new project. Both are deliberate: an
    // approval prompt you cannot see is a hang from the phone's point of view.
    // NOTE the config-file route does not work — approvalMode has no permissive
    // value ("runEverything" was tried and commands were still rejected), so the
    // flags are the only mechanism.
    launchArgv: ({ args }) => ['--force', '--trust', ...argList(args)],
    // `--resume [chatId]` takes an OPTIONAL id: with one it reopens that chat,
    // without one the CLI shows its own picker. Both are useful from a phone, so
    // an absent sessionId is passed through rather than treated as an error.
    resumeArgv: ({ sessionId, args }) => (
      sessionId
        ? ['--force', '--trust', '--resume', sessionId, ...argList(args)]
        : ['--force', '--trust', '--resume', ...argList(args)]
    ),
    isResumeId: (id) => SAFE_ID.test(id),
    refFor: (entry) => entry.sessionId,
    // Launch-only in the unified list, and unlike opencode this is not a
    // dependency question: cursor-agent keeps its chats server-side. ~/.cursor/agents
    // is empty and the local tracking DB holds only commit line-attribution, with
    // zero conversation rows — so there is genuinely nothing on this machine to
    // enumerate. `--resume` with no id hands that job to the CLI's own picker.
    discover: null,
  },

  shell: {
    id: 'shell',
    displayName: 'Shell',
    bin: path.basename(LOGIN_SHELL),
    envVar: 'CCR_SHELL',
    binCandidates: [LOGIN_SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'],
    icon: '❯',
    glyph: 'SH',
    color: '#8a8f98',
    // A login shell so the user's rc files, aliases and functions are present.
    launchArgv: ({ args }) => {
      const list = argList(args);
      return list.length ? list : ['-l'];
    },
    resumeArgv: null,
    isResumeId: () => false,
    refFor: (entry) => entry.sessionId,
    discover: null,
  },

  /**
   * Arbitrary command — the entry that turns every other one into a
   * convenience rather than a limit.
   *
   * `custom` is a registry entry like any other; it simply takes its argv from
   * the caller's `command` string instead of hardcoding one. Everything
   * downstream — tmux naming, the unified list, attach, detach, kill — treats
   * it exactly like `claude` or `codex`. That is the point: named tools and
   * ad-hoc commands are the same mechanism, so "run npm run dev" is not a
   * special case bolted on beside the tools.
   *
   * The command runs through the login shell, so pipes, `&&`, redirection,
   * globs and `$VAR` expansion all behave the way they do when the user types
   * them. One caveat worth knowing: zsh does not read .zshrc for a
   * non-interactive `-c` shell, so aliases and shell functions defined there
   * are not in scope. The `shell` preset is the escape hatch for those.
   */
  custom: {
    id: 'custom',
    displayName: 'Command',
    bin: path.basename(LOGIN_SHELL),
    envVar: 'CCR_SHELL',
    binCandidates: [LOGIN_SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'],
    icon: '▶',
    glyph: '$',
    color: '#c9a227',
    // Not offered as a tile in the "new session" picker: it is meaningless
    // without a command, and the client gets those from /api/commands.
    selectable: false,
    requiresCommand: true,
    launchArgv: ({ command, args }) => {
      const line = typeof command === 'string' ? command.trim() : '';
      if (!line) throw new Error('a custom session needs a non-empty command');
      // Extra args are quoted individually; the command itself is deliberately
      // NOT quoted, because shell syntax in it is the feature.
      const extra = argList(args);
      const full = extra.length ? `${line} ${extra.map(shQuote).join(' ')}` : line;
      return ['-lc', full];
    },
    resumeArgv: null,
    isResumeId: () => false,
    refFor: (entry) => entry.sessionId,
    discover: null,
  },
};

/** Kind assumed when a caller resumes a raw tool-native id without saying which tool. */
export const DEFAULT_KIND = 'claude';

/**
 * Kind used when a create request names neither a command nor a preset.
 *
 * A shell is the honest answer to "just give me a terminal": from it the user
 * can reach every tool on the machine, including ones this registry has never
 * heard of.
 */
export const BARE_LAUNCH_KIND = 'shell';

export function getKind(id) {
  return (typeof id === 'string' && Object.prototype.hasOwnProperty.call(KINDS, id) && KINDS[id]) || null;
}

export function kindIds() {
  return Object.keys(KINDS);
}

/**
 * Resolve a kind's binary to an absolute path.
 *
 * Deliberately re-checked at every launch rather than cached at import: a tool
 * installed or upgraded while the server is running should just work, and a
 * tool that has gone missing must produce a clear error instead of a PTY that
 * dies with a blank screen.
 *
 * @throws {Error} with a message naming every path that was tried.
 */
export function resolveKindBinary(kindId) {
  const kind = getKind(kindId);
  if (!kind) throw new Error(`unknown session kind "${kindId}"`);

  const override = kind.envVar ? process.env[kind.envVar] : null;
  if (override) {
    const found = firstExisting([override]);
    if (found) return found;
    throw binMissing(
      `${kind.envVar}="${override}" does not point at an executable file. ` +
        `Unset it to fall back to the default locations for ${kind.displayName}.`,
    );
  }

  const found = firstExisting(kind.binCandidates) || findOnHardenedPath(kind.bin);
  if (found) return found;

  throw binMissing(
    `${kind.displayName} is not installed where claude-remote looks for it. ` +
      `Tried: ${kind.binCandidates.join(', ')}, then \`${kind.bin}\` on PATH (${HARDENED_PATH}). ` +
      `Set ${kind.envVar} to its absolute path if it lives somewhere else.`,
  );
}

/** Tagged so the HTTP layer can answer 503 rather than a generic 400. */
function binMissing(message) {
  const err = new Error(message);
  err.code = 'BIN_NOT_FOUND';
  return err;
}

/** Non-throwing availability report, for /api/kinds and /api/health. */
export function describeKinds() {
  return kindIds().map((id) => {
    const kind = KINDS[id];
    let binPath = null;
    let error = null;
    try {
      binPath = resolveKindBinary(id);
    } catch (err) {
      error = err.message;
    }
    return {
      id,
      displayName: kind.displayName,
      icon: kind.icon,
      glyph: kind.glyph,
      color: kind.color,
      available: Boolean(binPath),
      binPath,
      error,
      resumable: typeof kind.resumeArgv === 'function',
      discoverable: typeof kind.discover === 'function',
      // false for `custom`, which is driven by a command string rather than
      // picked from a list. The client should not render it as a tile.
      selectable: kind.selectable !== false,
      requiresCommand: kind.requiresCommand === true,
      isDefault: id === DEFAULT_KIND,
    };
  });
}

/**
 * Every dormant session across every kind that can discover them.
 * One kind failing (a missing or unreadable state directory) must not blank
 * out the whole list, so failures are logged by the kind and skipped here.
 */
export async function discoverAllDormant() {
  const jobs = kindIds()
    .filter((id) => typeof KINDS[id].discover === 'function')
    .map(async (id) => {
      try {
        return await KINDS[id].discover();
      } catch {
        return [];
      }
    });
  const results = await Promise.all(jobs);
  return results.flat();
}

/* ------------------------------------------------------------------ *
 * tmux naming: the kind is encoded in the session name
 * ------------------------------------------------------------------ */

/**
 * Managed tmux sessions are named `ccr-<kind>-<slug>`.
 *
 * Encoding the kind in the name means a live session's kind survives a restart
 * of this server, and even the loss of .sessions.json, without ever having to
 * guess from the running command.
 */
export function tmuxNameFor(kindId, label) {
  const slug = String(label || kindId || 'session')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'session';
  return `${TMUX_PREFIX}${kindId}-${slug}`;
}

/** Recover the kind from a managed tmux session name, or null. */
export function kindFromTmuxName(name) {
  if (typeof name !== 'string' || !name.startsWith(TMUX_PREFIX)) return null;
  const rest = name.slice(TMUX_PREFIX.length);
  for (const id of kindIds()) {
    if (rest === id || rest.startsWith(`${id}-`)) return id;
  }
  return null;
}
