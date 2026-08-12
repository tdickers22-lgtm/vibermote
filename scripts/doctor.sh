#!/usr/bin/env bash
#
# doctor.sh — everything you need to know when the phone shows nothing.
#
# Read-only. It inspects state and prints it; it never starts, stops, installs
# or reconfigures anything. Exit status is 0 when all checks pass, 1 otherwise.

set -uo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

load_env

printf '%s\n' "${C_BOLD}claude-remote doctor${C_RESET}"
note "$(date '+%Y-%m-%d %H:%M:%S')  ·  $PROJECT_DIR"

# ---------------------------------------------------------------------------
step "Configuration"
# ---------------------------------------------------------------------------

if [ -f "$ENV_FILE" ]; then
  ok "config file: $ENV_FILE"
else
  info "no $ENV_FILE — using built-in defaults"
fi

info "CCR_PORT = $CCR_PORT"
if [ -n "$CCR_HOST" ]; then
  info "CCR_HOST = $CCR_HOST  (explicit override)"
else
  info "CCR_HOST = (unset — the server picks the address itself)"
fi

if RESOLVED_BIND="$(resolve_bind "$CCR_HOST")"; then
  if [ "$RESOLVED_BIND" = "127.0.0.1" ]; then
    warn "will bind to 127.0.0.1 — reachable from this Mac only, NOT from your phone"
    note "That is the fallback when no Tailscale interface is present. Fix"
    note "Tailscale (below) and the address changes on its own."
  elif is_tailscale_ip "$RESOLVED_BIND"; then
    ok "will bind to $RESOLVED_BIND (Tailscale, 100.64.0.0/10)"
  fi
else
  fail "CCR_HOST='$CCR_HOST' is not an allowed bind address — the server will refuse to start"
  note "Only a Tailscale address (100.64.0.0/10) or 127.0.0.1 is permitted, and"
  note "never 0.0.0.0. Leave CCR_HOST empty in $ENV_FILE to let the server choose."
  RESOLVED_BIND="<invalid>"
fi

# ---------------------------------------------------------------------------
step "Tailscale"
# ---------------------------------------------------------------------------

if TS_CLI="$(find_tailscale_cli)"; then
  ok "CLI: $TS_CLI"
  TS_STATE="$(tailscale_backend_state || true)"
  case "$TS_STATE" in
    Running)
      ok "backend state: Running"
      if TS_IP="$(tailscale_ipv4)"; then
        ok "this Mac's tailnet IPv4: $TS_IP"
      else
        fail "no IPv4 address assigned"
      fi
      ;;
    Stopped)
      fail "backend state: Stopped — Tailscale is installed but switched off"
      note "Fix:  tailscale up"
      ;;
    NeedsLogin)
      fail "backend state: NeedsLogin — not signed in"
      note "Fix:  tailscale up"
      ;;
    "")
      fail "could not read Tailscale status (is the app running?)"
      ;;
    *)
      warn "backend state: $TS_STATE"
      ;;
  esac
else
  fail "Tailscale is not installed — the phone has no route to this Mac"
  note "Fix:  brew install --cask tailscale   (then: tailscale up)"
fi

# ---------------------------------------------------------------------------
step "Listening socket"
# ---------------------------------------------------------------------------

LISTENER="$(port_listener "$CCR_PORT")"
if [ -n "$LISTENER" ]; then
  LISTENER_PID="${LISTENER%% *}"
  LISTENER_CMD="${LISTENER#* }"
  ok "port $CCR_PORT is listening — $LISTENER_CMD (pid $LISTENER_PID)"

  ADDRS="$(port_listen_addrs "$CCR_PORT")"
  while IFS= read -r addr; do
    [ -n "$addr" ] || continue
    case "$addr" in
      \*:*|0.0.0.0:*|"[::]":*)
        fail "listening on $addr — WILDCARD BIND, reachable from every network this Mac joins"
        note "This is the one configuration that must never ship. Stop the server,"
        note "set CCR_HOST=auto in $ENV_FILE, and restart it."
        ;;
      *)
        info "listening on $addr"
        ;;
    esac
  done <<EOF
$ADDRS
EOF

  if [ "$LISTENER_CMD" != "node" ]; then
    warn "the process on this port is '$LISTENER_CMD', not node — something else may have taken the port"
  fi
else
  fail "nothing is listening on port $CCR_PORT"
  note "Start it:  $SCRIPTS_DIR/start-server.sh"
  note "Or check the launchd job below, and the logs in $LOG_DIR"
fi

# ---------------------------------------------------------------------------
step "Dependencies"
# ---------------------------------------------------------------------------

if command -v tmux >/dev/null 2>&1; then
  ok "tmux: $(command -v tmux) ($(tmux -V))"
  SESSION_COUNT="$(tmux list-sessions 2>/dev/null | wc -l | tr -d ' ')"
  info "tmux sessions currently running: ${SESSION_COUNT:-0}"
else
  fail "tmux not found — sessions cannot be created"
  note "Fix:  brew install tmux"
fi

if NODE_BIN_DIR="$(resolve_node_bin_dir)"; then
  NODE="$NODE_BIN_DIR/node"
  NODE_MAJOR="$(node_major "$NODE" || echo 0)"
  if [ "$NODE_MAJOR" -ge 20 ]; then
    ok "node: $("$NODE" --version) ($NODE)"
  else
    fail "node $("$NODE" --version) is too old — need >= 20"
  fi
else
  fail "node not found"
fi

if command -v claude >/dev/null 2>&1; then
  ok "claude CLI: $(command -v claude)"
else
  fail "claude CLI not on PATH"
  note "The server spawns 'claude' inside tmux. Expected at ~/.local/bin/claude."
  note "Note that start-server.sh adds ~/.local/bin to PATH itself, so this can"
  note "fail here while still working under launchd — but check it anyway."
fi

if [ -f "$SERVER_ENTRY" ]; then
  ok "server entry point: $SERVER_ENTRY"
else
  fail "server entry point missing: $SERVER_ENTRY"
fi

if [ -d "$PROJECT_DIR/node_modules/node-pty" ]; then
  ok "node-pty installed"
else
  fail "node-pty missing — run scripts/setup.sh"
fi

if [ -d "$PROJECT_DIR/node_modules/ws" ]; then
  ok "ws installed"
else
  fail "ws missing — run scripts/setup.sh"
fi

# ---------------------------------------------------------------------------
step "Auth token"
# ---------------------------------------------------------------------------

if [ -f "$TOKEN_FILE" ]; then
  ok "token file exists: $TOKEN_FILE"

  PERMS="$(stat -f '%Lp' "$TOKEN_FILE" 2>/dev/null || echo '???')"
  if [ "$PERMS" = "600" ]; then
    ok "permissions: 0600"
  else
    fail "permissions: 0$PERMS — must be 0600"
    note "Fix:  chmod 600 $TOKEN_FILE"
  fi

  TOKEN_LEN="$(tr -d '[:space:]' < "$TOKEN_FILE" | wc -c | tr -d ' ')"
  if [ "$TOKEN_LEN" -ge 32 ]; then
    ok "token length: $TOKEN_LEN chars"
  else
    fail "token is only $TOKEN_LEN chars — suspiciously short, rotate it"
    note "Fix:  $SCRIPTS_DIR/rotate-token.sh"
  fi
  note "(the token value is deliberately not printed here — run setup.sh to see it)"
else
  fail "no token file at $TOKEN_FILE"
  note "Fix:  $SCRIPTS_DIR/setup.sh"
fi

# ---------------------------------------------------------------------------
step "launchd job ($PLIST_LABEL)"
# ---------------------------------------------------------------------------

if [ -f "$PLIST_DEST" ]; then
  ok "installed: $PLIST_DEST"
else
  info "not installed at $PLIST_DEST"
  note "Autostart is optional. To enable it:"
  note "  cp $PLIST_SRC $PLIST_DEST"
  note "  launchctl load -w $PLIST_DEST"
fi

if launchd_loaded; then
  ok "job is loaded"
  STATUS="$(launchd_status)"
  JOB_PID="${STATUS%% *}"
  JOB_EXIT="${STATUS#* }"
  if [ "$JOB_PID" != "-" ] && [ -n "$JOB_PID" ]; then
    ok "running as pid $JOB_PID"
  else
    warn "loaded but not currently running (last exit status: $JOB_EXIT)"
    if [ "$JOB_EXIT" != "0" ]; then
      note "A non-zero exit means it crashed or refused to start. Check the logs below."
    fi
  fi
else
  info "job is not loaded"
fi

# ---------------------------------------------------------------------------
step "Logs"
# ---------------------------------------------------------------------------

if [ -d "$LOG_DIR" ]; then
  ok "log directory: $LOG_DIR"
  for f in "$LOG_DIR/server.err.log" "$LOG_DIR/server.out.log"; do
    if [ -s "$f" ]; then
      info "last lines of $(basename "$f"):"
      tail -n 8 "$f" | sed 's/^/         /'
    elif [ -f "$f" ]; then
      info "$(basename "$f") is empty"
    fi
  done
else
  warn "no log directory at $LOG_DIR — launchd cannot write logs until it exists"
  note "Fix:  mkdir -p $LOG_DIR   (or just run scripts/setup.sh)"
fi

# ---------------------------------------------------------------------------
blank
printf '%s\n' "${C_BOLD}────────────────────────────────────────────────────────────${C_RESET}"
if [ "$CR_PROBLEMS" -eq 0 ]; then
  printf '%s\n' "${C_GREEN}${C_BOLD}All checks passed.${C_RESET}"
  if [ -n "${TS_IP:-}" ]; then
    blank
    say "Phone URL:  http://$TS_IP:$CCR_PORT/"
  fi
  blank
  exit 0
fi

printf '%s\n' "${C_YELLOW}${C_BOLD}$CR_PROBLEMS problem(s) found — see WARN/FAIL above.${C_RESET}"
blank
exit 1
