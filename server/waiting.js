/**
 * Does this screen look like it is waiting for a human?
 *
 * Extracted so the tmux watcher and the Terminal.app watcher classify screens
 * by identical rules. Two things must never drift apart here: a notification
 * and the badge on the card have to agree, or the app is lying to you.
 */
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

/** The last few non-empty lines, which is where every prompt in practice lives. */
export function tailOf(pane, lines = 12) {
  return pane
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim())
    .slice(-lines)
    .join('\n');
}

export function looksLikeWaiting(pane) {
  const tail = tailOf(pane);
  if (!tail) return false;
  if (BUSY_PATTERNS.some((re) => re.test(tail))) return false;
  return WAITING_PATTERNS.some((re) => re.test(tail));
}
