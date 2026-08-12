# shellcheck shell=bash
#
# Shared helpers for the claude-remote operational scripts.
# Sourced by setup.sh, doctor.sh, start-server.sh and rotate-token.sh.
#
# Written for bash 3.2 (the /bin/bash that ships with macOS) — no associative
# arrays, no ${var,,}, no mapfile.

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

# This file lives at <project>/scripts/lib/common.sh, so the project root is
# two levels up. Deriving it beats hardcoding: the tree stays movable.
CR_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$CR_LIB_DIR/../.." && pwd)"
SCRIPTS_DIR="$PROJECT_DIR/scripts"
LOG_DIR="$PROJECT_DIR/logs"
TOKEN_FILE="$PROJECT_DIR/.token"
ENV_FILE="$PROJECT_DIR/.env"
SERVER_ENTRY="$PROJECT_DIR/server/index.js"

PLIST_LABEL="com.tobias.claude-remote"
PLIST_SRC="$PROJECT_DIR/$PLIST_LABEL.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"

DEFAULT_PORT=8787

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'
else
  C_RESET=''; C_BOLD=''; C_DIM=''
  C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''
fi

# Tracks whether anything went wrong, so a script can exit non-zero at the end
# instead of bailing on the first problem. Both setup and doctor are more
# useful when they report every issue in one pass.
CR_PROBLEMS=0

say()  { printf '%s\n' "$*"; }
blank() { printf '\n'; }

# A numbered, titled section. setup.sh uses this to explain what it is about
# to do before it does it.
step() {
  blank
  printf '%s\n' "${C_BOLD}${C_BLUE}==> $*${C_RESET}"
}

ok()   { printf '  %s %s\n' "${C_GREEN}OK  ${C_RESET}" "$*"; }
info() { printf '  %s %s\n' "${C_BLUE}INFO${C_RESET}" "$*"; }
warn() { printf '  %s %s\n' "${C_YELLOW}WARN${C_RESET}" "$*"; CR_PROBLEMS=$((CR_PROBLEMS + 1)); }
fail() { printf '  %s %s\n' "${C_RED}FAIL${C_RESET}" "$*"; CR_PROBLEMS=$((CR_PROBLEMS + 1)); }

# Indented explanatory prose. This is the "explain, don't silently do" channel.
note() { printf '       %s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }

# A command the user must run themselves (sudo / interactive / GUI login).
cmd() { printf '       %s$ %s%s\n' "$C_BOLD" "$*" "$C_RESET"; }

die() {
  printf '%s\n' "${C_RED}${C_BOLD}error:${C_RESET} $*" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# Environment file
# ---------------------------------------------------------------------------

# Reads .env into the environment. The format is plain KEY=VALUE lines so that
# both bash and the Node server can consume it without a parser dependency.
load_env() {
  if [ -f "$ENV_FILE" ]; then
    # shellcheck disable=SC1090
    . "$ENV_FILE"
  fi
  # These names are the server's, defined in server/config.js. Keeping one
  # vocabulary across shell and Node means there is no translation layer to
  # drift out of sync.
  : "${CCR_PORT:=$DEFAULT_PORT}"

  # CCR_HOST is an *override*. Left empty, server/net.js finds the Tailscale
  # interface itself and falls back to loopback. We deliberately do not force a
  # value in that case: the server's detection reads network interfaces
  # directly and therefore works even when the Tailscale CLI is absent, which
  # is the norm for the Mac App Store build.
  : "${CCR_HOST:=}"

  export CCR_PORT CCR_HOST
}

# ---------------------------------------------------------------------------
# Tailscale
# ---------------------------------------------------------------------------

# The Tailscale CLI lives in a different place depending on how it was
# installed. The Homebrew cask and the Mac App Store build both ship it inside
# the .app bundle; the Homebrew *formula* puts it on PATH.
find_tailscale_cli() {
  local candidate
  for candidate in \
    "$(command -v tailscale 2>/dev/null)" \
    /Applications/Tailscale.app/Contents/MacOS/Tailscale \
    /opt/homebrew/bin/tailscale \
    /usr/local/bin/tailscale
  do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

# "Running" means the tailnet is actually up, not merely installed.
tailscale_backend_state() {
  local ts
  ts="$(find_tailscale_cli)" || return 1
  "$ts" status --json 2>/dev/null \
    | grep -o '"BackendState"[[:space:]]*:[[:space:]]*"[^"]*"' \
    | head -1 \
    | sed 's/.*"\([^"]*\)"$/\1/'
}

# Reads the tailnet address straight off the network interfaces, exactly as
# server/net.js does. This is the more reliable of the two methods: the Mac App
# Store build of Tailscale often ships no CLI on PATH at all, but the interface
# is there whenever the tailnet is up.
tailscale_ipv4_from_iface() {
  local ip
  for ip in $(ifconfig 2>/dev/null | awk '$1 == "inet" {print $2}'); do
    if is_tailscale_ip "$ip"; then
      printf '%s\n' "$ip"
      return 0
    fi
  done
  return 1
}

tailscale_ipv4() {
  local ts ip
  if ts="$(find_tailscale_cli)"; then
    ip="$("$ts" ip -4 2>/dev/null | head -1 | tr -d '[:space:]')"
    if [ -n "$ip" ]; then
      printf '%s\n' "$ip"
      return 0
    fi
  fi
  tailscale_ipv4_from_iface
}

# Tailscale hands out addresses from the CGNAT block 100.64.0.0/10, i.e. first
# octet 100 and second octet in [64,127]. Anything else is not a tailnet
# address and must not be treated as a safe bind target.
is_tailscale_ip() {
  local ip="$1" o1 o2
  case "$ip" in
    *.*.*.*) ;;
    *) return 1 ;;
  esac
  o1="${ip%%.*}"
  o2="${ip#*.}"; o2="${o2%%.*}"
  case "$o1$o2" in
    *[!0-9]*) return 1 ;;
  esac
  [ "$o1" -eq 100 ] || return 1
  [ "$o2" -ge 64 ] && [ "$o2" -le 127 ]
}

# Predicts the address the server will bind to, mirroring resolveBindAddress()
# in server/net.js. An empty argument means "no CCR_HOST override", which is
# the normal case.
#
# Returns 1 for addresses the server will reject, so the scripts can say so up
# front instead of letting the user discover it from a crash log.
resolve_bind() {
  local requested="${1:-}" ip
  case "$requested" in
    ''|auto)
      if ip="$(tailscale_ipv4)" && is_tailscale_ip "$ip"; then
        printf '%s\n' "$ip"
      else
        printf '%s\n' "127.0.0.1"
      fi
      ;;
    0.0.0.0|"::"|"*")
      return 1
      ;;
    127.0.0.1|::1|localhost)
      printf '%s\n' "$requested"
      ;;
    *)
      # The server allows only loopback or a Tailscale address.
      if is_tailscale_ip "$requested"; then
        printf '%s\n' "$requested"
      else
        return 1
      fi
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Node
# ---------------------------------------------------------------------------

# launchd starts jobs with a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin), and
# this machine's node comes from nvm — which is a shell function, not something
# launchd can invoke. So we locate a concrete node binary and put its directory
# on PATH ourselves.
#
# Echoes the directory containing node.
resolve_node_bin_dir() {
  local n candidate

  if [ -n "${CCR_NODE_BIN:-}" ] && [ -x "${CCR_NODE_BIN}/node" ]; then
    printf '%s\n' "$CCR_NODE_BIN"
    return 0
  fi

  n="$(command -v node 2>/dev/null)"
  if [ -n "$n" ] && [ -x "$n" ]; then
    dirname "$n"
    return 0
  fi

  # Highest nvm-installed version that satisfies engines.node >= 20.
  if [ -d "$HOME/.nvm/versions/node" ]; then
    candidate="$(
      ls -1 "$HOME/.nvm/versions/node" 2>/dev/null \
        | sed 's/^v//' \
        | awk -F. '$1 >= 20' \
        | sort -t. -k1,1n -k2,2n -k3,3n \
        | tail -1
    )"
    if [ -n "$candidate" ] && [ -x "$HOME/.nvm/versions/node/v$candidate/bin/node" ]; then
      printf '%s\n' "$HOME/.nvm/versions/node/v$candidate/bin"
      return 0
    fi
  fi

  for candidate in /opt/homebrew/bin /usr/local/bin; do
    if [ -x "$candidate/node" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

node_major() {
  local v
  v="$("$1" --version 2>/dev/null)" || return 1
  v="${v#v}"
  printf '%s\n' "${v%%.*}"
}

# ---------------------------------------------------------------------------
# Runtime state
# ---------------------------------------------------------------------------

# Everything the server needs to find on PATH:
#   ~/.local/bin    -> the `claude` CLI itself (this is the one that bites;
#                      without it every session dies "claude: command not found")
#   /opt/homebrew/bin -> tmux
#   node bin dir    -> node
build_runtime_path() {
  local node_dir="$1"
  printf '%s\n' "$HOME/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:$node_dir:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
}

# Which process, if any, is listening on the port. Echoes "<pid> <command>".
port_listener() {
  local port="$1"
  lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $2" "$1}'
}

# Every address the port is listening on, one per line (e.g. "100.x.y.z:8787").
port_listen_addrs() {
  local port="$1"
  lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $9}' | sort -u
}

launchd_loaded() {
  launchctl list 2>/dev/null | grep -q "[[:space:]]${PLIST_LABEL}\$"
}

# Echoes "<pid> <last-exit-status>" for the launchd job, or nothing.
launchd_status() {
  launchctl list 2>/dev/null | awk -v label="$PLIST_LABEL" '$3 == label {print $1" "$2}'
}
