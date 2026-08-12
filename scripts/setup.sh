#!/usr/bin/env bash
#
# setup.sh — take this Mac from "fresh clone" to "phone can drive Claude Code".
#
# Safe to re-run: it never regenerates an existing token, never clobbers an
# existing .env, and never installs anything that needs sudo. Steps that
# require your hands (Homebrew, `tailscale up`, loading the launch agent) are
# printed for you to run, not executed.

set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

TAILSCALE_READY=0
TAILSCALE_IP=""
SKIP_INSTALL=0

usage() {
  cat <<USAGE
Usage: setup.sh [options]

  --skip-install   Don't run npm install. Useful when re-running setup just to
                   re-check Tailscale or reprint the phone URL and token.
  -h, --help       Show this message.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-install) SKIP_INSTALL=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
  shift
done

printf '%s\n' "${C_BOLD}claude-remote setup${C_RESET}"
note "Project: $PROJECT_DIR"
note "This script explains each step before doing it. Nothing here needs sudo."

# ---------------------------------------------------------------------------
step "1/8  tmux"
# ---------------------------------------------------------------------------
note "Sessions are real Claude Code processes running inside tmux. tmux is what"
note "lets a session survive your phone dropping off wifi — the PTY keeps running"
note "and we just reattach to it."

if command -v tmux >/dev/null 2>&1; then
  ok "tmux found: $(command -v tmux) ($(tmux -V))"
else
  fail "tmux not found — the server cannot create sessions without it."
  note "Install it yourself (needs Homebrew, which we will not run for you):"
  cmd "brew install tmux"
fi

# ---------------------------------------------------------------------------
step "2/8  node"
# ---------------------------------------------------------------------------
note "The server is Node 20+ ESM. We resolve a concrete node binary rather than"
note "relying on nvm, because launchd cannot call a shell function."

if NODE_BIN_DIR="$(resolve_node_bin_dir)"; then
  NODE="$NODE_BIN_DIR/node"
  NODE_MAJOR="$(node_major "$NODE" || echo 0)"
  if [ "$NODE_MAJOR" -ge 20 ]; then
    ok "node $("$NODE" --version) at $NODE"
  else
    fail "node $NODE_MAJOR at $NODE is too old — need >= 20."
    cmd "nvm install 20 && nvm use 20"
  fi
else
  fail "no node found."
  cmd "nvm install 20"
  NODE=""
fi

# ---------------------------------------------------------------------------
step "3/8  Xcode command line tools"
# ---------------------------------------------------------------------------
note "node-pty is a native addon — it allocates the pseudo-terminals that carry"
note "the Claude Code TUI. If npm has to build it from source it needs a compiler."

if xcode-select -p >/dev/null 2>&1; then
  ok "command line tools present: $(xcode-select -p)"
else
  warn "Xcode command line tools not detected."
  note "npm install may still succeed using a prebuilt binary. If it fails while"
  note "building node-pty, run this and re-run setup:"
  cmd "xcode-select --install"
fi

# ---------------------------------------------------------------------------
step "4/8  Tailscale"
# ---------------------------------------------------------------------------
note "Tailscale is the whole security model. The server binds to this Mac's"
note "tailnet address, which only your own signed-in devices can reach. Nothing"
note "is exposed to the public internet and no ports are forwarded."

if TS_CLI="$(find_tailscale_cli)"; then
  ok "Tailscale CLI: $TS_CLI"

  TS_STATE="$(tailscale_backend_state || true)"
  if [ "$TS_STATE" = "Running" ]; then
    if TAILSCALE_IP="$(tailscale_ipv4)" && is_tailscale_ip "$TAILSCALE_IP"; then
      ok "tailnet up — this Mac is $TAILSCALE_IP"
      TAILSCALE_READY=1
    else
      warn "Tailscale is running but reported no usable IPv4 address."
      note "Got: '${TAILSCALE_IP:-<empty>}' (expected something in 100.64.0.0/10)"
    fi
  else
    warn "Tailscale is installed but not connected (state: ${TS_STATE:-unknown})."
    note "Sign in — this opens a browser and needs your account, so run it yourself:"
    cmd "tailscale up"
  fi
else
  warn "Tailscale is not installed."
  note "Install it with ONE of the following. Both need sudo or an interactive"
  note "login, so run whichever you prefer yourself:"
  blank
  note "  Homebrew cask:"
  cmd "brew install --cask tailscale"
  note "  ...or the Mac App Store build:"
  cmd "open 'macappstores://apps.apple.com/app/tailscale/id1475387142'"
  blank
  note "Then start it and sign in:"
  cmd "tailscale up"
  blank
  note "Re-run this script afterwards and it will pick up your tailnet address."
fi

# ---------------------------------------------------------------------------
step "5/8  npm install"
# ---------------------------------------------------------------------------
note "Dependencies are deliberately tiny: ws (WebSocket) and node-pty (PTYs)."

if [ "$SKIP_INSTALL" -eq 1 ]; then
  info "skipped (--skip-install)"
elif [ ! -f "$PROJECT_DIR/package.json" ]; then
  fail "no package.json at $PROJECT_DIR — nothing to install."
elif [ -z "${NODE:-}" ]; then
  warn "skipping npm install because no usable node was found."
else
  export PATH="$NODE_BIN_DIR:$PATH"
  if [ -f "$PROJECT_DIR/package-lock.json" ]; then
    info "running: npm ci  (lockfile present — reproducible install)"
    if ! (cd "$PROJECT_DIR" && npm ci --no-audit --no-fund); then
      warn "npm ci failed; retrying with npm install"
      (cd "$PROJECT_DIR" && npm install --no-audit --no-fund) \
        || fail "npm install failed — see the output above."
    fi
  else
    info "running: npm install"
    (cd "$PROJECT_DIR" && npm install --no-audit --no-fund) \
      || fail "npm install failed — see the output above."
  fi

  if [ -d "$PROJECT_DIR/node_modules/node-pty" ]; then
    ok "node-pty installed"
  else
    fail "node-pty is missing after install — the server cannot open PTYs."
  fi
fi

# ---------------------------------------------------------------------------
step "6/8  Configuration and log directory"
# ---------------------------------------------------------------------------

mkdir -p "$LOG_DIR"
ok "log directory ready: $LOG_DIR"
note "launchd cannot redirect output into a directory that does not exist, so"
note "this has to be created before you load the launch agent."

if [ -f "$ENV_FILE" ]; then
  ok "$ENV_FILE already exists — leaving your settings alone"
else
  cat > "$ENV_FILE" <<'ENVEOF'
# claude-remote configuration.
#
# Read by scripts/start-server.sh, which exports these to the server. The names
# match server/config.js, so anything valid here is valid as a plain shell
# environment variable too.

# Port the server listens on.
CCR_PORT=8787

# Bind address OVERRIDE. Leave this empty in normal use: the server finds this
# Mac's Tailscale address by itself and falls back to 127.0.0.1 when the
# tailnet is down.
#
# Only a Tailscale address (100.64.0.0/10) or 127.0.0.1 is accepted. 0.0.0.0 is
# rejected by both the start script and the server: this endpoint hands out a
# shell, and a wildcard bind would expose it on every network this Mac joins,
# including coffee shop wifi.
CCR_HOST=

# Optional binary overrides; both are auto-detected when left unset.
# CCR_TMUX=/opt/homebrew/bin/tmux
# CCR_CLAUDE=/Users/tobiasdicker/.local/bin/claude
ENVEOF
  chmod 600 "$ENV_FILE"
  ok "wrote default configuration to $ENV_FILE"
fi

# Load .env so the port check and the phone URL below reflect real config.
load_env

if LISTENER="$(port_listener "$CCR_PORT")" && [ -n "$LISTENER" ]; then
  LISTENER_PID="${LISTENER%% *}"
  LISTENER_CMD="${LISTENER#* }"
  if [ "$LISTENER_CMD" = "node" ]; then
    info "port $CCR_PORT is already served by node (pid $LISTENER_PID) — probably claude-remote itself"
  else
    warn "port $CCR_PORT is already in use by $LISTENER_CMD (pid $LISTENER_PID)"
    note "Either stop that process or change CCR_PORT in $ENV_FILE"
  fi
else
  ok "port $CCR_PORT is free"
fi

chmod +x "$SCRIPTS_DIR"/*.sh 2>/dev/null || true

# ---------------------------------------------------------------------------
step "7/8  Auth token"
# ---------------------------------------------------------------------------
note "Every HTTP request and the WebSocket upgrade must carry this bearer token."
note "It is the only thing between someone on your tailnet and a shell on this"
note "Mac, so it is generated with openssl and stored 0600."

if [ -f "$TOKEN_FILE" ]; then
  ok "token already exists at $TOKEN_FILE — keeping it"
  note "(re-running setup never rotates your token; use scripts/rotate-token.sh)"
else
  # umask first so the file is never briefly world-readable in the window
  # between the write and the chmod.
  ( umask 077 && openssl rand -hex 32 > "$TOKEN_FILE" ) \
    || die "failed to generate token with openssl"
  chmod 600 "$TOKEN_FILE"
  ok "generated a new 256-bit token at $TOKEN_FILE"
fi

TOKEN_PERMS="$(stat -f '%Lp' "$TOKEN_FILE" 2>/dev/null || echo '???')"
if [ "$TOKEN_PERMS" = "600" ]; then
  ok "token permissions are 0600"
else
  warn "token permissions are 0$TOKEN_PERMS — tightening to 0600"
  chmod 600 "$TOKEN_FILE"
fi

# If this ever becomes a git repo, make sure the token cannot be committed.
if git -C "$PROJECT_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  if git -C "$PROJECT_DIR" check-ignore -q "$TOKEN_FILE" 2>/dev/null; then
    ok ".token is git-ignored"
  else
    warn ".token is NOT git-ignored — add '.token' and '.env' to .gitignore before committing."
  fi
fi

# ---------------------------------------------------------------------------
step "8/8  Start at login (optional)"
# ---------------------------------------------------------------------------
note "A launchd agent keeps the server running and restarts it if it crashes."
note "Installing it changes what your Mac runs at login, so we print the"
note "commands instead of doing it behind your back:"
blank
cmd "cp $PLIST_SRC $PLIST_DEST"
cmd "launchctl load -w $PLIST_DEST"
blank
note "To stop it permanently, 'launchctl unload' is not enough on this machine —"
note "it comes back at next login. Use:"
cmd "launchctl unload -w $PLIST_DEST"

if launchd_loaded; then
  blank
  ok "the launch agent is already loaded"
fi

# ---------------------------------------------------------------------------
# Final report
# ---------------------------------------------------------------------------

blank
printf '%s\n' "${C_BOLD}────────────────────────────────────────────────────────────${C_RESET}"

TOKEN_VALUE="$(cat "$TOKEN_FILE" 2>/dev/null || echo '<unreadable>')"

if [ "$TAILSCALE_READY" -eq 1 ]; then
  blank
  printf '%s\n' "${C_BOLD}On your phone:${C_RESET}"
  blank
  say "  1. Install Tailscale from the App Store / Play Store."
  say "  2. Sign in with the SAME account you used on this Mac."
  say "  3. Confirm this Mac appears in the phone's device list."
  say "  4. Open this URL in the phone's browser. It carries the token, so it"
  say "     logs you straight in — mail it to yourself or scan it across:"
  blank
  printf '        %s%shttp://%s:%s/?token=%s%s\n' \
    "$C_BOLD" "$C_GREEN" "$TAILSCALE_IP" "$CCR_PORT" "$TOKEN_VALUE" "$C_RESET"
  blank
  say "  5. Add it to your home screen (Share -> Add to Home Screen) so it"
  say "     opens fullscreen like a real app."
  blank
  note "Prefer to keep the secret out of the URL? Open the bare address instead"
  note "and paste the token when the page asks:"
  blank
  printf '        %shttp://%s:%s/%s\n' "$C_BOLD" "$TAILSCALE_IP" "$CCR_PORT" "$C_RESET"
  printf '        %s%s%s\n' "$C_BOLD" "$TOKEN_VALUE" "$C_RESET"
  blank
  note "That token is a shell on this Mac. Treat it like a password: do not"
  note "paste it into a group chat, do not commit it. If it leaks, rotate it:"
  note "  scripts/rotate-token.sh"
else
  blank
  printf '%s\n' "${C_YELLOW}${C_BOLD}Tailscale is not connected yet, so there is no phone URL to print.${C_RESET}"
  note "Finish the Tailscale steps above, then re-run this script:"
  cmd "$SCRIPTS_DIR/setup.sh"
  blank
  say "Your token (already generated, it will not change):"
  blank
  printf '        %s%s%s\n' "$C_BOLD" "$TOKEN_VALUE" "$C_RESET"
fi

blank
printf '%s\n' "${C_BOLD}To start the server now:${C_RESET}"
cmd "$SCRIPTS_DIR/start-server.sh"
blank
printf '%s\n' "${C_BOLD}If anything misbehaves:${C_RESET}"
cmd "$SCRIPTS_DIR/doctor.sh"
blank

if [ "$CR_PROBLEMS" -gt 0 ]; then
  printf '%s\n' "${C_YELLOW}Setup finished with $CR_PROBLEMS item(s) needing your attention (see WARN/FAIL above).${C_RESET}"
  blank
  exit 1
fi

printf '%s\n' "${C_GREEN}${C_BOLD}Setup complete.${C_RESET}"
blank
