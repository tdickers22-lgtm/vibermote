#!/usr/bin/env bash
#
# rotate-token.sh — replace the bearer token.
#
# Run this if the token was ever pasted somewhere it shouldn't be: a chat, a
# screenshot, a commit, a shared terminal. Rotating invalidates every existing
# phone session, which is the point.

set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

load_env

printf '%s\n' "${C_BOLD}Rotate claude-remote auth token${C_RESET}"
blank

if [ -f "$TOKEN_FILE" ]; then
  note "This replaces the token at $TOKEN_FILE."
  note "Every device currently connected will be logged out and must be given"
  note "the new token."
  blank

  if [ -t 0 ]; then
    printf 'Continue? [y/N] '
    read -r reply
    case "$reply" in
      y|Y|yes|YES) ;;
      *) say "Aborted — token unchanged."; exit 0 ;;
    esac
  else
    note "(non-interactive shell — proceeding)"
  fi

  # Keep one generation of backup so a rotation done by mistake is recoverable.
  cp "$TOKEN_FILE" "$TOKEN_FILE.previous"
  chmod 600 "$TOKEN_FILE.previous"
  info "previous token saved to $(basename "$TOKEN_FILE").previous"
else
  note "No existing token — generating the first one."
fi

( umask 077 && openssl rand -hex 32 > "$TOKEN_FILE" ) \
  || die "failed to generate token with openssl"
chmod 600 "$TOKEN_FILE"

ok "new token written to $TOKEN_FILE"
blank
printf '%s\n' "${C_BOLD}New token:${C_RESET}"
blank
printf '    %s%s%s\n' "$C_BOLD" "$(cat "$TOKEN_FILE")" "$C_RESET"
blank

say "Now restart the server so it reloads the token:"
blank
if launchd_loaded; then
  cmd "launchctl kickstart -k gui/$(id -u)/$PLIST_LABEL"
else
  cmd "$SCRIPTS_DIR/start-server.sh"
fi
blank
say "Then re-enter the new token on your phone."
blank
note "Once you have confirmed the phone works, delete the backup:"
cmd "rm $TOKEN_FILE.previous"
blank
