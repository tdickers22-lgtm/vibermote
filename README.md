# Claude Remote

Drive every Claude Code session running on your Mac from your phone, over Tailscale, from anywhere.

Open the app on your phone and you get the **real** Claude Code TUI — not a reimplementation. Every
slash command works, including the ones no mobile app can do (`/plugin`, `/resume`, `/subscribe`).
Ctrl+C interrupts. Sessions survive your phone falling off the network, because they are real tmux
sessions on your Mac and your phone is just a window onto them.

Only the Mac needs to be online. The phone can be on cellular on the other side of the world.

---

## How it works

```
  phone browser                    your Mac
  ┌──────────────┐                 ┌──────────────────────────────────┐
  │  xterm.js    │  WebSocket      │  node server ──► tmux ──► claude  │
  │  (PWA)       │◄───────────────►│  (bearer-token auth)             │
  └──────────────┘   Tailscale     └──────────────────────────────────┘
```

The server runs a real `claude` process inside tmux and streams the actual PTY to your phone.
Nothing about the Claude Code UI is reimplemented, so nothing breaks when Claude Code updates.
tmux gives detach/reattach for free: a dropped connection never kills a session.

---

## Security model

**Read this part.** This endpoint hands out a shell on your development machine. Auth is
load-bearing, not decorative.

1. **Tailscale only. Never the public internet.**
   The server binds to your Mac's Tailscale address (in the `100.64.0.0/10` CGNAT range) or to
   `127.0.0.1`. It never binds `0.0.0.0`. Both `scripts/start-server.sh` and the server itself
   reject a wildcard bind outright, and a bind address that is neither loopback nor Tailscale is
   refused too — a LAN address would expose your shell to every device on the coffee-shop wifi.
   No ports are forwarded and nothing is published to the internet.

2. **A bearer token on every request.**
   Every HTTP request and the WebSocket upgrade must present a 256-bit token. An unauthenticated
   WebSocket upgrade would be a full compromise, so the same check guards both. Repeated failures
   from one address get locked out.

3. **The token is a password.**
   It lives at `.token` with `0600` permissions and is never logged. Anyone who has it can run
   commands on your Mac. Don't paste it into chat, don't commit it, don't screenshot it. If it
   leaks, [rotate it](#rotating-the-token) — that takes about ten seconds.

Tailscale and the token are independent layers. Someone would need to be on your tailnet *and*
hold the token.

---

## Setup

### Part 1 — on the Mac

**Step 1. Install Tailscale** (skip if you already have it).

```sh
brew install --cask tailscale
```

or install the Mac App Store build. Then sign in:

```sh
tailscale up
```

This needs your account and opens a browser, so the setup script will not do it for you.

**Step 2. Run setup.**

```sh
cd ~/claude-remote
./scripts/setup.sh
```

It is safe to re-run at any time. It explains every step as it goes, and it will:

- check tmux, Node 20+, and the Xcode command line tools (`node-pty` is a native addon)
- report your Tailscale address, or print the exact commands to fix Tailscale if it isn't ready
- `npm install`
- generate the auth token if `.token` doesn't exist yet (`openssl rand -hex 32`, `chmod 600`)
- write a default `.env` and create `logs/`
- print the URL and token to use on your phone

Nothing in it needs `sudo`. Anything that does is printed for you to run yourself.

**Step 3. Start the server.**

```sh
./scripts/start-server.sh
```

Leave it running, or set up autostart (below) so it's always there.

### Part 2 — on the phone

1. Install **Tailscale** from the App Store / Play Store.
2. Sign in with the **same account** you used on the Mac.
3. Check that your Mac appears in the phone's device list.
4. Open the URL that `setup.sh` printed. It looks like:

   ```
   http://100.x.y.z:8787/?token=<your-token>
   ```

   That link carries the token, so it logs you straight in. The easiest way to get it onto the
   phone is to mail or message it to yourself.

   Prefer to keep the secret out of the URL? Open `http://100.x.y.z:8787/` instead and paste the
   token into the prompt. Either way the phone remembers it.

5. **Add to Home Screen** (Share → Add to Home Screen). It's a PWA, so it then opens fullscreen
   with no browser chrome and behaves like a native app.

---

## Autostart at login

A launchd agent keeps the server running and restarts it if it crashes.

**Install and enable:**

```sh
cp ~/claude-remote/com.tobias.claude-remote.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.tobias.claude-remote.plist
```

**Disable:**

```sh
launchctl unload -w ~/Library/LaunchAgents/com.tobias.claude-remote.plist
```

> **The `-w` matters on both sides.** A plain `launchctl unload` stops the job for this boot only —
> the agent gets re-registered at your next login and the server quietly comes back, which looks
> exactly like the unload silently failed. `unload -w` writes the disabled flag to the per-user
> override database, and that is what actually persists.

**Restart it** (after changing config or rotating the token):

```sh
launchctl kickstart -k gui/$(id -u)/com.tobias.claude-remote
```

**Logs** go to `logs/server.out.log` and `logs/server.err.log`. `logs/` must exist before you load
the agent or launchd cannot redirect into it — `setup.sh` creates it.

The agent runs `scripts/start-server.sh` rather than `node` directly, because launchd starts jobs
with `PATH=/usr/bin:/bin:/usr/sbin:/sbin` and without your shell profile. Node comes from nvm, tmux
from Homebrew, and `claude` from `~/.local/bin` — none of which are on that PATH. The wrapper
rebuilds a usable environment (and a UTF-8 locale, or the TUI's box-drawing renders as garbage)
and then `exec`s node, so launchd still supervises the real server process.

---

## Configuration

`.env` in the project root. The names match `server/config.js`, so they work as plain environment
variables too.

| Variable | Default | Meaning |
|---|---|---|
| `CCR_PORT` | `8787` | Port to listen on. |
| `CCR_HOST` | *(empty)* | Bind address **override**. Leave empty — the server finds your Tailscale address itself and falls back to loopback. Only a `100.64.0.0/10` address or `127.0.0.1` is accepted. |
| `CCR_TMUX` | auto | Path to the tmux binary. |
| `CCR_CLAUDE` | auto | Path to the `claude` binary. |

Restart the server after editing.

---

## Rotating the token

Rotate whenever the token might have been seen by anyone else — pasted into a chat, caught in a
screenshot, committed by accident, or typed on a shared screen.

```sh
./scripts/rotate-token.sh
```

It backs up the old token to `.token.previous`, writes a fresh 256-bit one at `0600`, prints it,
and tells you how to restart the server. Then re-enter the new token on your phone; every existing
session is logged out, which is the entire point.

Once the phone is working again, delete the backup:

```sh
rm ~/claude-remote/.token.previous
```

---

## Troubleshooting

Run this first. It checks everything below and tells you which one is wrong:

```sh
./scripts/doctor.sh
```

It prints the bind address, whether the port is listening, Tailscale status, tmux, Node version,
token presence and permissions, whether the launchd job is loaded, and the tail of the logs.

### Tailscale is not connected

Symptom: `doctor.sh` says the bind address is `127.0.0.1`, or the phone cannot load the page at all.

The server falls back to loopback when it finds no Tailscale interface. It's then reachable from
the Mac but not from the phone.

```sh
tailscale status     # what state is it in?
tailscale up         # sign in / reconnect
tailscale ip -4      # should print a 100.x.y.z address
```

Then restart the server so it picks up the new address. Also check on the phone:

- Tailscale is **on** (the VPN toggle in iOS Settings genuinely flips off sometimes)
- it's signed into the **same account**
- your Mac shows as online in the phone's device list

If the Mac's tailnet address changed, the old bookmark points at the wrong IP. Re-run
`./scripts/setup.sh` to print the current URL.

### Port already in use

Symptom: the server exits at startup with `EADDRINUSE`, or `doctor.sh` reports the port is held by
something that isn't node.

Find the culprit:

```sh
lsof -nP -iTCP:8787 -sTCP:LISTEN
```

Usually it's an older copy of this server that didn't exit. Either stop it, or pick another port in
`.env`:

```sh
CCR_PORT=8788
```

Then restart, and use the new port in the phone URL. If the launchd agent is loaded, note that it
will restart the server for you — `kill` alone won't free the port for long. Unload it first, or
use `launchctl kickstart -k` to restart it cleanly.

### tmux is missing

Symptom: the app loads and authenticates, but creating a session fails.

```sh
brew install tmux
which tmux           # expect /opt/homebrew/bin/tmux
```

If tmux lives somewhere unusual, point at it explicitly in `.env`:

```sh
CCR_TMUX=/your/path/to/tmux
```

Under launchd this fails in a way worth knowing about: launchd's minimal PATH doesn't include
Homebrew, so a server started by the launch agent can't find tmux even though your terminal can.
`scripts/start-server.sh` exists to fix exactly that, which is why the plist calls it instead of
calling `node` directly.

### The app shows a blank terminal

The page loads, you're authenticated, but the terminal area is empty or frozen.

1. **Is anything actually running?** Check the logs:

   ```sh
   tail -n 50 ~/claude-remote/logs/server.err.log
   ```

2. **Can the Mac find `claude`?**

   ```sh
   which claude       # expect ~/.local/bin/claude
   ```

   This is the classic launchd failure: `claude` lives in `~/.local/bin`, which is not on launchd's
   PATH, so the PTY opens and the process immediately dies with "command not found". `doctor.sh`
   checks for this.

3. **Look at the tmux session directly on the Mac.** This tells you whether the problem is the
   session or the streaming:

   ```sh
   tmux ls
   tmux attach -t <session-name>
   ```

   If the session looks fine in Terminal but blank on the phone, it's the WebSocket, not Claude.

4. **Mojibake instead of blankness?** If you get boxes and question marks rather than the TUI's
   borders, the locale isn't UTF-8. The plist sets `LANG`/`LC_ALL` to `en_US.UTF-8`; if you start
   the server by hand from an odd environment, export those yourself.

5. **Force-reload the PWA.** Once added to the home screen it caches aggressively. Close it fully
   and reopen, or delete and re-add it from the browser.

6. **Rotated the token but didn't restart?** The server reads the token at startup. Restart it.

### It worked yesterday and now the phone gets nothing

Most often the Mac slept. Tailscale reconnects on wake, but if the Mac is fully asleep it isn't
serving anything. Check Settings → Battery → "Prevent automatic sleeping when the display is off"
if you want it reachable around the clock.

---

## Files

```
claude-remote/
├── com.tobias.claude-remote.plist   launchd agent (copy to ~/Library/LaunchAgents/)
├── .env                             your config (created by setup.sh)
├── .token                           bearer token, 0600 (created by setup.sh)
├── logs/                            server.out.log, server.err.log
├── scripts/
│   ├── setup.sh                     one-time setup; safe to re-run
│   ├── start-server.sh              launches the server (used by launchd too)
│   ├── doctor.sh                    diagnostics — run this when it doesn't work
│   ├── rotate-token.sh              replace the auth token
│   └── lib/common.sh                shared helpers
├── server/                          node server: tmux control, PTY streaming, auth
└── public/                          the phone app (PWA, xterm.js, no build step)
```

`.token` and `.env` must never be committed.

---

## Uninstall

```sh
launchctl unload -w ~/Library/LaunchAgents/com.tobias.claude-remote.plist
rm ~/Library/LaunchAgents/com.tobias.claude-remote.plist
tmux ls | grep '^ccr-' | cut -d: -f1 | xargs -n1 tmux kill-session -t
rm -rf ~/claude-remote
```

The third line kills only this tool's own tmux sessions — they're all prefixed `ccr-`, so your own
tmux sessions are left alone.
