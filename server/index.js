/**
 * claude-remote server entry point.
 *
 * Binds to Tailscale (or loopback), serves the HTTP API and the websocket
 * terminal transport, and never exposes itself to the public internet.
 */
import http from 'node:http';
import { loadOrCreateToken, getToken } from './auth.js';
import { PORT, PROJECT_ROOT, TMUX_BIN, HARDENED_PATH } from './config.js';
import { describeKinds } from './kinds.js';
import { resolveBindAddress } from './net.js';
import { createHttpHandler } from './http-api.js';
import { attachWebSocketServer } from './ws-api.js';
import { detachAll, allBrokers, peekBroker } from './sessions.js';
import { loadOrCreateVapidKeys, subscriptionCount } from './push.js';
import { startSessionWatch, stopSessionWatch } from './session-watch.js';
import * as tmuxApi from './tmux.js';
import { log } from './util.js';

async function main() {
  const { created, path: tokenPath } = loadOrCreateToken();
  // Generated on first run and then kept forever: rotating it would silently
  // invalidate every phone's existing subscription.
  const vapid = loadOrCreateVapidKeys();

  let bind;
  try {
    bind = resolveBindAddress();
  } catch (err) {
    log.error(err.message);
    process.exit(1);
  }

  const tmuxVersion = await tmuxApi.serverVersion();
  if (!tmuxVersion) {
    log.error(`tmux not usable at ${TMUX_BIN}. Set CCR_TMUX to its absolute path.`);
    process.exit(1);
  }

  const bindInfo = { ...bind, port: PORT };
  const server = http.createServer(createHttpHandler({ bindInfo }));

  // Terminal sessions are long-lived and mostly idle; the default 5s header
  // timeout and 2m keep-alive would churn connections needlessly.
  server.keepAliveTimeout = 75_000;
  server.headersTimeout = 80_000;
  server.requestTimeout = 0;

  attachWebSocketServer(server);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log.error(`port ${PORT} is already in use on ${bind.host}. Set CCR_PORT to pick another.`);
    } else if (err.code === 'EADDRNOTAVAIL') {
      log.error(
        `cannot bind ${bind.host} — that address is not on this machine. ` +
          `If Tailscale just started, re-run; otherwise set CCR_HOST.`,
      );
    } else {
      log.error('server error:', err);
    }
    process.exit(1);
  });

  await new Promise((resolve) => server.listen(PORT, bind.host, resolve));

  const base = `http://${bind.host}:${PORT}`;
  log.info('─'.repeat(64));
  log.info(`claude-remote listening on ${base}`);
  log.info(`  bind reason : ${bind.reason}`);
  log.info(`  tailscale   : ${bind.tailscaleIP ? `${bind.tailscaleIP} (${bind.iface})` : 'not detected'}`);
  log.info(`  tmux        : ${tmuxVersion} at ${TMUX_BIN}`);
  log.info(`  root        : ${PROJECT_ROOT}`);
  log.info(`  token       : ${tokenPath}${created ? ' (generated just now)' : ''}`);
  // The public half only — the private key is a secret of the same weight as
  // the token and util.js redacts it from every log line as a backstop.
  log.info(`  push        : ${subscriptionCount()} device(s), key ${vapid.publicKey.slice(0, 12)}…`);
  log.info(`  PATH        : ${HARDENED_PATH}`);
  // Report every kind at startup so a missing tool is obvious here rather than
  // at the moment the user taps "new session" on their phone.
  for (const k of describeKinds()) {
    const state = k.available ? k.binPath : `UNAVAILABLE — ${k.error}`;
    log.info(`  ${k.id.padEnd(10)}: ${state}`);
  }
  if (!bind.tailscaleIP) {
    log.warn('  bound to loopback — the phone cannot reach this until Tailscale is up.');
  }
  log.info('─'.repeat(64));
  // The token itself is deliberately never printed; read it from the file.
  // (util.js also redacts it from every log line as a backstop.)

  // Watches tmux for finished processes and sessions waiting on input, and
  // pushes to subscribed phones. It polls tmux rather than the PTY because the
  // PTY is gone by the time any of this matters — see session-watch.js.
  startSessionWatch({ viewersOf: (name) => peekBroker(name)?.subscribers.size || 0 });

  /* -------------------- shutdown -------------------- */
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received — detaching ${allBrokers().length} PTY(s); tmux sessions keep running`);
    stopSessionWatch();
    // Detach, never kill: the whole point of tmux here is that the user's
    // work survives the remote server going away.
    detachAll();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // A crash must not take the tmux sessions with it, and must not leave the
  // process wedged in a half-dead state.
  process.on('uncaughtException', (err) => {
    log.error('uncaught exception:', err);
  });
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection:', reason instanceof Error ? reason : String(reason));
  });

  // Touch getToken() so a misconfigured token file fails loudly at startup
  // rather than on the first request.
  getToken();
}

main().catch((err) => {
  log.error('fatal:', err);
  process.exit(1);
});
