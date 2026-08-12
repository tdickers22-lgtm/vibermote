/**
 * Kind registry — which CLI a session is running.
 *
 * A "kind" is claude | codex | shell | opencode. The server is meant to publish
 * these via `GET /api/kinds`, but this module must keep the app usable when it
 * does not: the server currently on disk has no such endpoint, and worse, it
 * already uses the field name `kind` on a session to mean live|dormant. So we
 * treat the built-in table as the source of truth for *presentation* and let the
 * server override availability, display name and colour when it answers.
 */

/** Ordered so the New-session sheet and the filter bar agree. */
const BUILTIN = [
  {
    id: 'claude',
    name: 'Claude Code',
    color: '#d97757',
    paletteTitle: 'Slash commands',
    paletteKey: '/ cmds',
    slash: true,
    commands: [
      { cmd: '/model', desc: 'Switch the active model' },
      { cmd: '/effort', desc: 'Set the reasoning effort level' },
      { cmd: '/compact', desc: 'Summarise and compact the context' },
      { cmd: '/clear', desc: 'Clear the conversation history' },
      { cmd: '/resume', desc: 'Resume an earlier session' },
      { cmd: '/context', desc: 'Show context-window usage' },
      { cmd: '/cost', desc: 'Token usage and cost' },
      { cmd: '/status', desc: 'Session and account status' },
      { cmd: '/agents', desc: 'Manage subagents' },
      { cmd: '/mcp', desc: 'MCP server connections' },
      { cmd: '/config', desc: 'Open settings' },
      { cmd: '/help', desc: 'List every command' },
    ],
  },
  {
    id: 'codex',
    name: 'Codex',
    color: '#7fb069',
    paletteTitle: 'Codex commands',
    paletteKey: '/ cmds',
    slash: true,
    commands: [
      { cmd: '/model', desc: 'Choose model and reasoning effort' },
      { cmd: '/approvals', desc: 'Change approval / sandbox mode' },
      { cmd: '/new', desc: 'Start a fresh conversation' },
      { cmd: '/compact', desc: 'Summarise the conversation so far' },
      { cmd: '/diff', desc: 'Show the working-tree diff' },
      { cmd: '/review', desc: 'Review the current changes' },
      { cmd: '/status', desc: 'Session, model and token status' },
      { cmd: '/mcp', desc: 'Configured MCP servers' },
      { cmd: '/init', desc: 'Write an AGENTS.md for this repo' },
      { cmd: '/mention', desc: 'Reference a file in the prompt' },
      { cmd: '/undo', desc: 'Revert the last agent edit' },
      { cmd: '/quit', desc: 'Exit Codex' },
    ],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    color: '#c48bb8',
    paletteTitle: 'OpenCode commands',
    paletteKey: '/ cmds',
    slash: true,
    commands: [
      { cmd: '/models', desc: 'Switch the active model' },
      { cmd: '/sessions', desc: 'List and switch sessions' },
      { cmd: '/new', desc: 'Start a new session' },
      { cmd: '/compact', desc: 'Compact the conversation' },
      { cmd: '/init', desc: 'Write an AGENTS.md for this repo' },
      { cmd: '/undo', desc: 'Undo the last change' },
      { cmd: '/redo', desc: 'Redo the last undone change' },
      { cmd: '/share', desc: 'Share this session' },
      { cmd: '/editor', desc: 'Compose in the external editor' },
      { cmd: '/themes', desc: 'Change the colour theme' },
      { cmd: '/help', desc: 'List every command' },
      { cmd: '/exit', desc: 'Quit OpenCode' },
    ],
  },
  {
    id: 'shell',
    name: 'Shell',
    color: '#6b9bd1',
    paletteTitle: 'Shortcuts',
    paletteKey: 'snips',
    slash: false,
    // A shell has no slash commands; the palette becomes a snippet list so the
    // button is still worth its 44px instead of showing commands that would be
    // typed into a prompt that cannot understand them.
    commands: [
      { cmd: 'git status', desc: 'Working-tree status' },
      { cmd: 'git diff', desc: 'Unstaged changes' },
      { cmd: 'git log --oneline -20', desc: 'Recent commits' },
      { cmd: 'ls -la', desc: 'List the current directory' },
      { cmd: 'pwd', desc: 'Print the working directory' },
      { cmd: 'clear', desc: 'Clear the screen' },
      { cmd: 'exit', desc: 'End the shell' },
    ],
  },
  {
    id: 'custom',
    name: 'Command',
    color: '#c9a227',
    paletteTitle: 'Shortcuts',
    paletteKey: 'snips',
    slash: false,
    // Never a tile in the new-session sheet: a command session is meaningless
    // without the command, which comes from a text field, not a picker. It is
    // in the registry so that a session running one is *labelled* correctly —
    // "npm run dev" is a Command, not a Shell.
    selectable: false,
    commands: [
      { cmd: 'clear', desc: 'Clear the screen' },
      { cmd: 'exit', desc: 'End the session' },
    ],
  },
];

const UNKNOWN = {
  id: 'unknown',
  name: 'Session',
  color: '#a8a396',
  paletteTitle: 'Shortcuts',
  paletteKey: 'snips',
  slash: false,
  commands: [],
};

const BUILTIN_BY_ID = new Map(BUILTIN.map((k) => [k.id, k]));

/**
 * Ids we accept as a genuine CLI kind (so `kind:"live"` cannot masquerade).
 * Mutated in place by applyServerKinds() — importers hold this same Set, so a
 * kind the server grows is accepted without a client release.
 */
export const KIND_IDS = new Set(BUILTIN.map((k) => k.id));

/**
 * Live registry. `available` is tri-state:
 *   true  — the server confirmed the binary exists
 *   false — the server confirmed it does not (we grey the option out)
 *   null  — the server never told us (we stay permissive)
 */
let registry = BUILTIN.map((k) => ({ ...k, available: null }));
let serverReported = false;

export function allKinds() { return registry; }

export function kindsReported() { return serverReported; }

export function getKind(id) {
  return registry.find((k) => k.id === id) || BUILTIN_BY_ID.get(id) || UNKNOWN;
}

export function kindName(id) { return getKind(id).name; }
export function kindColor(id) { return getKind(id).color; }

export function isAvailable(id) { return getKind(id).available !== false; }

/**
 * Merge `GET /api/kinds`. Unknown ids from the server are appended rather than
 * dropped, so a server that grows a new kind does not need a client release.
 */
export function applyServerKinds(list) {
  if (!Array.isArray(list) || !list.length) return;
  serverReported = true;

  const seen = new Set();
  const merged = [];

  for (const entry of list) {
    const id = String(entry?.id || '').toLowerCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const base = BUILTIN_BY_ID.get(id) || { ...UNKNOWN, id, name: id };
    // `displayName` is what the server on disk actually sends; `name` is the
    // agreed contract. Accept either rather than silently keeping the built-in.
    const label = firstString(entry.name, entry.displayName);
    merged.push({
      ...base,
      name: label || base.name,
      color: isColor(entry.color) ? entry.color : base.color,
      available: typeof entry.available === 'boolean' ? entry.available : null,
      // The server decides what may be picked from a list; `custom` says no,
      // because it needs a command string the picker cannot supply.
      selectable: entry.selectable === false ? false : base.selectable !== false,
    });
    KIND_IDS.add(id);
  }

  // Keep built-ins the server omitted, flagged unavailable: the server has
  // spoken, and silence about a kind it knows about means "not installed".
  for (const base of BUILTIN) {
    if (!seen.has(base.id)) merged.push({ ...base, available: false });
  }

  registry = merged;
}

function isColor(value) {
  return typeof value === 'string' && /^#[0-9a-f]{3,8}$/i.test(value);
}

function firstString(...candidates) {
  for (const c of candidates) if (typeof c === 'string' && c.trim()) return c.trim();
  return null;
}

/** Kinds worth offering as a tile in the new-session picker. */
export function selectableKinds() {
  return registry.filter((k) => k.selectable !== false);
}

/* ------------------------------------------------------------------ *
 * Inference
 * ------------------------------------------------------------------ */

/**
 * Work out a session's kind when the server does not say.
 *
 * Deliberately ignores `kind` when it holds "live"/"dormant", because the
 * server on disk overloads that field with the session's lifecycle state.
 */
export function inferKind(raw) {
  const declared = String(raw?.kind || '').toLowerCase();
  if (KIND_IDS.has(declared)) return declared;

  const hay = [
    raw?.command,
    raw?.live?.command,
    raw?.bin,
    Array.isArray(raw?.args) ? raw.args.join(' ') : '',
    raw?.label,
  ].filter(Boolean).join(' ').toLowerCase();

  if (/\bcodex\b/.test(hay)) return 'codex';
  if (/\bopencode\b/.test(hay)) return 'opencode';
  if (/\bclaude\b/.test(hay)) return 'claude';
  if (/\b(zsh|bash|fish|login|-sh|shell)\b/.test(hay)) return 'shell';

  // Dormant rows come from ~/.claude/projects transcripts, so they are Claude
  // by construction whatever the pane command says.
  if (typeof raw?.id === 'string' && raw.id.startsWith('dormant:')) return 'claude';

  // `claude` is a node script, so tmux frequently reports the pane command as
  // "node" rather than "claude".
  if (/\bnode\b/.test(hay)) return 'claude';

  return 'claude';
}
