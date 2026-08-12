#!/usr/bin/env bash
#
# start-server.sh — launch the claude-remote server.
#
# This is the entry point named by com.tobias.claude-remote.plist, and it is
# also the supported way to start the server by hand. It exists because
# launchd is a hostile environment for a Node app on this machine:
#
#   * launchd's PATH is /usr/bin:/bin:/usr/sbin:/sbin. node comes from nvm,
#     tmux from Homebrew, and `claude` from ~/.local/bin — none of which are
#     on that PATH. A server started without this wrapper appears to boot
#     fine and then fails the moment it tries to spawn a session.
#   * launchd does not source your shell profile, so nvm (a shell function)
#     never runs.
#   * A PTY carrying the Claude Code TUI needs a UTF-8 locale or every box
#     drawing character renders as garbage.
#
# Resolving all of that here keeps the plist static and the server ignorant of
# how it was started.

set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

load_env

# --- node -------------------------------------------------------------------

NODE_BIN_DIR="$(resolve_node_bin_dir)" || die \
  "no node >= 20 found. Install one (nvm install 20) or set CCR_NODE_BIN
 to the directory containing the node binary."

NODE="$NODE_BIN_DIR/node"
major="$(node_major "$NODE")" || die "could not run $NODE --version"
[ "$major" -ge 20 ] || die "node $major is too old; this project needs node >= 20 (found $NODE)"

# --- PATH and locale --------------------------------------------------------

PATH="$(build_runtime_path "$NODE_BIN_DIR")"
export PATH

# A PTY without a UTF-8 locale mangles the TUI's box drawing.
export LANG="${LANG:-en_US.UTF-8}"
export LC_ALL="${LC_ALL:-en_US.UTF-8}"

# tmux inherits this for panes it creates; xterm.js speaks xterm-256color.
export TERM="${TERM:-xterm-256color}"

# --- bind address -----------------------------------------------------------

# CCR_HOST is an override. When it is empty the server picks the address
# itself, so we pass nothing and let server/net.js decide — it reads the
# network interfaces directly and works without the Tailscale CLI.
#
# When the user *has* pinned an address we validate it here too, so a bad
# value produces a clear message instead of a stack trace in a log file the
# user has not thought to open yet.
if ! BIND="$(resolve_bind "$CCR_HOST")"; then
  die "refusing to start: CCR_HOST='$CCR_HOST' is not an allowed bind address.
 This server hands out a shell on your Mac, so it may bind only to a Tailscale
 address (100.64.0.0/10) or 127.0.0.1 — never 0.0.0.0. Leave CCR_HOST empty in
 $ENV_FILE to let the server choose."
fi

if [ -n "$CCR_HOST" ]; then
  export CCR_HOST
else
  # Explicitly unset, so a stray value in the environment cannot leak in.
  unset CCR_HOST
fi
export CCR_PORT

if [ "$BIND" = "127.0.0.1" ]; then
  say "warning: no Tailscale address found, so the server will bind to 127.0.0.1."
  say "         It will work on this Mac but your phone will not reach it."
  say "         Run 'tailscale up', then restart the server."
fi

# --- preflight --------------------------------------------------------------

[ -f "$SERVER_ENTRY" ] || die "server entry point not found: $SERVER_ENTRY"

# The server generates a token on first start if one is missing, so this is a
# notice rather than a fatal error — otherwise a first boot under launchd
# would never get off the ground.
if [ ! -f "$TOKEN_FILE" ]; then
  say "notice: no token at $TOKEN_FILE yet — the server will generate one."
  say "        Run scripts/setup.sh afterwards to print it for your phone."
fi

mkdir -p "$LOG_DIR"

cd "$PROJECT_DIR"

say "claude-remote starting"
say "  node   $("$NODE" --version) ($NODE)"
say "  bind   $BIND:$CCR_PORT"
say "  tmux   $(command -v tmux || echo 'NOT FOUND')"
say "  claude $(command -v claude || echo 'NOT FOUND')"

# exec so the server becomes PID 1 of this job: launchd then supervises the
# node process directly, and KeepAlive restarts reflect real crashes rather
# than the wrapper exiting.
exec "$NODE" "$SERVER_ENTRY"
