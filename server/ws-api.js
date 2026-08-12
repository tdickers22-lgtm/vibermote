/**
 * WebSocket transport: one socket per attached viewer, many viewers per session.
 *
 * FRAME CONTRACT (both directions)
 *   binary frame -> raw terminal bytes
 *   text frame   -> a JSON control message
 *
 * That single rule is the whole protocol. It means the client can pipe every
 * binary frame straight into xterm.js `term.write()` without inspecting it, and
 * never has to base64-encode terminal output.
 */
import { WebSocketServer } from 'ws';
import { checkAuth } from './auth.js';
import { WS_BACKPRESSURE_BYTES, WS_PING_MS, DEFAULT_COLS, DEFAULT_ROWS } from './config.js';
import { parseId } from './discovery.js';
import { getBroker } from './sessions.js';
import * as tmuxApi from './tmux.js';
import { log } from './util.js';

export const CLOSE = {
  UNAUTHORIZED: 4001,
  DETACHED: 4002,
  NOT_FOUND: 4003,
  SESSION_ENDED: 4004,
  TOO_SLOW: 4005,
  BAD_REQUEST: 4006,
};

/** Control characters for the convenience `signal` message. */
const SIGNAL_BYTES = {
  SIGINT: 0x03, // Ctrl+C — interrupt whatever Claude is doing
  SIGQUIT: 0x1c,
  SIGTSTP: 0x1a, // Ctrl+Z
  EOF: 0x04, // Ctrl+D
};

function sendControl(ws, payload) {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(payload)); // text frame
  } catch (err) {
    log.debug(`control send failed: ${err.message}`);
  }
}

/**
 * Wire a broker's coalesced output to all of its subscribers exactly once.
 * A per-subscriber listener would re-serialise the same buffer N times and
 * leak listeners as phones come and go.
 */
function ensureFanout(broker) {
  if (broker.__fanoutInstalled) return;
  broker.__fanoutInstalled = true;

  broker.on('data', (buf) => {
    for (const sub of broker.subscribers) {
      const { ws } = sub;
      if (ws.readyState !== ws.OPEN) continue;

      // A viewer too slow to drain cannot be allowed to buffer without bound.
      // Dropping bytes would desynchronise the terminal, so we close instead;
      // the client reconnects and gets a fresh capture-pane replay, which is a
      // correct resync rather than a corrupted screen.
      if (ws.bufferedAmount > WS_BACKPRESSURE_BYTES) {
        log.warn(`dropping slow client on ${broker.name} (buffered ${ws.bufferedAmount})`);
        try {
          ws.close(CLOSE.TOO_SLOW, 'too slow');
        } catch {
          /* already gone */
        }
        continue;
      }

      try {
        ws.send(buf, { binary: true });
      } catch (err) {
        log.debug(`data send failed on ${broker.name}: ${err.message}`);
      }
    }
  });

  broker.on('pty-exit', ({ exitCode, signal, sessionAlive }) => {
    for (const sub of [...broker.subscribers]) {
      sendControl(sub.ws, { type: 'exit', exitCode, signal: signal ?? null, sessionAlive });
      try {
        sub.ws.close(sessionAlive ? CLOSE.DETACHED : CLOSE.SESSION_ENDED, sessionAlive ? 'detached' : 'session ended');
      } catch {
        /* already gone */
      }
    }
  });
}

export function attachWebSocketServer(httpServer) {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  httpServer.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      socket.destroy();
      return;
    }

    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    // Auth BEFORE the handshake completes. An unauthenticated upgrade here
    // would be a full compromise of the machine, so this must never be
    // deferred into the connection handler.
    const auth = checkAuth(req, url);
    if (!auth.ok) {
      log.warn(`ws upgrade rejected from ${req.socket.remoteAddress}: ${auth.error}`);
      socket.write(`HTTP/1.1 ${auth.status} ${auth.status === 429 ? 'Too Many Requests' : 'Unauthorized'}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      handleConnection(ws, url).catch((err) => {
        log.error('ws connection error:', err);
        sendControl(ws, { type: 'error', message: err.message });
        try {
          ws.close(CLOSE.BAD_REQUEST, 'error');
        } catch {
          /* already gone */
        }
      });
    });
  });

  // Liveness sweep: phones sleep and leave half-open sockets that would
  // otherwise sit in subscriber sets forever, holding PTYs open.
  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.__alive === false) {
        log.debug('terminating unresponsive websocket');
        ws.terminate();
        continue;
      }
      ws.__alive = false;
      try {
        ws.ping();
      } catch {
        /* ignore */
      }
    }
  }, WS_PING_MS);
  if (typeof interval.unref === 'function') interval.unref();

  wss.on('close', () => clearInterval(interval));
  return wss;
}

async function handleConnection(ws, url) {
  ws.__alive = true;
  ws.on('pong', () => {
    ws.__alive = true;
  });

  const id = url.searchParams.get('session');
  const parsed = parseId(id);

  if (parsed?.status !== 'live') {
    sendControl(ws, {
      type: 'error',
      message:
        'session must be a live id (live:<tmux-name>). To open a dormant session of ' +
        'any kind, POST /api/sessions {resume:"<dormant-id>"} first and connect to ' +
        'the live id it returns.',
    });
    ws.close(CLOSE.BAD_REQUEST, 'bad session id');
    return;
  }

  const { tmuxName } = parsed;
  if (!(await tmuxApi.hasSession(tmuxName))) {
    sendControl(ws, { type: 'error', message: `no such session: ${tmuxName}` });
    ws.close(CLOSE.NOT_FOUND, 'no such session');
    return;
  }

  const broker = getBroker(tmuxName);
  ensureFanout(broker);

  const sub = {
    ws,
    cols: clampInt(url.searchParams.get('cols'), DEFAULT_COLS, 20, 500),
    rows: clampInt(url.searchParams.get('rows'), DEFAULT_ROWS, 5, 200),
    close: (code, reason) => {
      try {
        ws.close(code, reason);
      } catch {
        /* already gone */
      }
    },
  };

  broker.addSubscriber(sub);
  // Size the PTY before spawning it: starting at the wrong geometry makes the
  // TUI paint one corrupted frame before the first resize lands.
  broker.applyResize();

  try {
    await broker.ensurePty();
  } catch (err) {
    broker.removeSubscriber(sub);
    sendControl(ws, { type: 'error', message: `failed to attach: ${err.message}` });
    ws.close(CLOSE.BAD_REQUEST, 'attach failed');
    return;
  }

  const replay = await broker.replayBuffer();

  sendControl(ws, {
    type: 'attached',
    id,
    tmuxName,
    cols: broker.cols,
    rows: broker.rows,
    subscribers: broker.subscribers.size,
    replayBytes: replay.length,
  });

  // Scrollback first, then live output. tmux repaints the visible region a
  // moment later when the PTY attaches; the replay is what puts *history*
  // on screen immediately instead of a blank rectangle.
  if (replay.length && ws.readyState === ws.OPEN) {
    ws.send(replay, { binary: true });
  }

  // A second viewer changing the shared geometry must not silently reflow the
  // first viewer's screen with no explanation.
  notifyPeers(broker, sub);

  ws.on('message', (data, isBinary) => {
    ws.__alive = true;

    if (isBinary) {
      broker.write(data); // raw keystrokes straight through
      return;
    }

    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      sendControl(ws, { type: 'error', message: 'control frames must be JSON' });
      return;
    }
    handleControl(msg, { ws, sub, broker });
  });

  const detachSub = () => {
    broker.removeSubscriber(sub);
    log.debug(`subscriber left ${tmuxName} (${broker.subscribers.size} remain)`);
    // Remaining viewers may now be able to use a larger geometry.
    if (broker.applyResize()) notifyPeers(broker, null);
  };

  ws.on('close', detachSub);
  ws.on('error', (err) => {
    log.debug(`ws error on ${tmuxName}: ${err.message}`);
    detachSub();
  });
}

function handleControl(msg, { ws, sub, broker }) {
  switch (msg?.type) {
    case 'input': {
      if (typeof msg.data !== 'string') {
        sendControl(ws, { type: 'error', message: 'input.data must be a string' });
        return;
      }
      broker.write(Buffer.from(msg.data, 'utf8'));
      return;
    }

    case 'resize': {
      const cols = clampInt(msg.cols, sub.cols, 20, 500);
      const rows = clampInt(msg.rows, sub.rows, 5, 200);
      sub.cols = cols;
      sub.rows = rows;
      if (broker.applyResize()) notifyPeers(broker, null);
      else sendControl(ws, { type: 'resize', cols: broker.cols, rows: broker.rows, reason: 'unchanged' });
      return;
    }

    case 'signal': {
      const byte = SIGNAL_BYTES[msg.name];
      if (byte == null) {
        sendControl(ws, { type: 'error', message: `unknown signal: ${msg.name}` });
        return;
      }
      broker.write(Buffer.from([byte]));
      return;
    }

    case 'ping': {
      sendControl(ws, { type: 'pong', t: msg.t ?? Date.now() });
      return;
    }

    case 'detach': {
      // Detach this viewer only. The tmux session and any other viewers are
      // untouched; the PTY lingers briefly in case this phone comes back.
      sub.close(CLOSE.DETACHED, 'detached');
      return;
    }

    default:
      sendControl(ws, { type: 'error', message: `unknown control type: ${msg?.type}` });
  }
}

/** Tell everyone the shared geometry, so a reflow is never unexplained. */
function notifyPeers(broker, origin) {
  for (const s of broker.subscribers) {
    sendControl(s.ws, {
      type: 'resize',
      cols: broker.cols,
      rows: broker.rows,
      reason: s === origin ? 'self' : 'peer',
      subscribers: broker.subscribers.size,
    });
  }
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
