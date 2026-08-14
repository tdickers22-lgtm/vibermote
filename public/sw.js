/**
 * Service worker: caches the app shell so the home-screen app opens instantly
 * and survives a dropped link, and receives push notifications when the app is
 * closed — without ever caching session data.
 *
 * Hard rule: /api/* and /ws are never read from or written to the cache. A
 * stale session list is misleading, and a cached 200 for an authenticated
 * endpoint would be a token-scoped response served to a later, tokenless load.
 *
 * The bearer token is deliberately NOT available here. This worker runs when no
 * page is open, so anything it could read it could leak; it therefore never
 * calls the API. Re-subscribing after iOS expires a subscription needs the
 * token, so that job is handed to the page instead — see pushsubscriptionchange.
 *
 * NOTE: service workers need a secure context. Reaching the Mac over plain
 * http:// at a Tailscale IP is not one, so this file is inert there — see
 * registerServiceWorker() in js/main.js. Run the server behind
 * `tailscale serve` (HTTPS) to get it.
 */

/**
 * BUMP THIS whenever the SHELL list below changes, or whenever a client change
 * must reach an already-installed app on its next launch rather than the one
 * after. Static assets are served stale-while-revalidate, so without a bump the
 * first load after a deploy still runs the previous build.
 */
const VERSION = 'v24';
const CACHE = `term-remote-shell-${VERSION}`;

/**
 * Everything needed to paint a usable first frame offline. Kept explicit rather
 * than glob-based: a wrong entry here fails the whole install. It must list
 * every stylesheet index.html links and every module main.js imports — a
 * missing entry is not a build error, just an app that renders unstyled or
 * half-dead when the Mac is unreachable.
 */
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/tokens.css',
  './css/chrome.css',
  './css/controls.css',
  './css/sessions.css',
  './css/launcher.css',
  './css/usage.css',
  './css/terminals.css',
  './css/terminal.css',
  './js/main.js',
  './js/api.js',
  './js/ui.js',
  './js/push.js',
  './js/kinds.js',
  './js/env.js',
  './js/keybar.js',
  './js/session-term.js',
  './js/viewport.js',
  './js/views/sessions.js',
  './js/views/terminals.js',
  './js/views/usage.js',
  './vendor/xterm.css',
  './vendor/xterm.mjs',
  './vendor/addon-fit.mjs',
  './vendor/addon-web-links.mjs',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-192.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-64.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Individually, so one 404 cannot abort the install and leave the app
    // permanently uncached.
    await Promise.all(SHELL.map(async (url) => {
      try {
        const res = await fetch(new Request(url, { cache: 'reload' }));
        if (res.ok) await cache.put(url, res);
      } catch { /* skip */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('term-remote-shell-') && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

function isApi(url) {
  return url.pathname.startsWith('/api/') || url.pathname === '/ws';
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isApi(url)) return; // straight to the network, never cached

  // Navigations: network first so a redeployed client is picked up promptly,
  // falling back to the cached shell when the Mac is unreachable.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch {
        const cache = await caches.open(CACHE);
        return (await cache.match('./index.html'))
          || (await cache.match('./'))
          || Response.error();
      }
    })());
    return;
  }

  // Static assets: serve from cache immediately, refresh in the background so
  // the next launch has the new build.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(request, { ignoreSearch: false });

    const network = fetch(request).then((res) => {
      if (res && res.ok && res.type === 'basic') cache.put(request, res.clone()).catch(() => {});
      return res;
    }).catch(() => null);

    if (hit) return hit;
    const res = await network;
    return res || Response.error();
  })());
});

/* ------------------------------------------------------------------ *
 * Push notifications
 * ------------------------------------------------------------------ */

/**
 * Show every push that arrives.
 *
 * The subscription was made with `userVisibleOnly: true`, which is a promise to
 * the browser that each message produces a visible notification. Breaking it
 * gets the subscription revoked, so even a malformed payload falls back to a
 * generic card rather than silently returning.
 */
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }

  const title = typeof data.title === 'string' && data.title ? data.title : 'Vibermote';
  const options = {
    body: typeof data.body === 'string' ? data.body : '',
    icon: './icons/icon-192.png',
    badge: './icons/favicon-64.png',
    // One card per session: a newer update replaces the older one instead of
    // stacking three notifications for the same terminal.
    tag: typeof data.tag === 'string' && data.tag ? data.tag : 'vibermote',
    renotify: true,
    timestamp: typeof data.at === 'number' ? data.at : Date.now(),
    data: {
      sessionId: typeof data.sessionId === 'string' ? data.sessionId : null,
      event: typeof data.event === 'string' ? data.event : null,
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

/**
 * Tapping a notification opens that session, not just the app.
 *
 * An already-open window is focused and told which session to show, because
 * navigating it would throw away the terminals the user has attached. Only when
 * nothing is open do we launch with `?session=` for main.js to pick up.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const sessionId = event.notification.data?.sessionId || '';

  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

    for (const client of clientList) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      client.postMessage({ type: 'cr:open-session', sessionId });
      if ('focus' in client) await client.focus();
      return;
    }

    const target = new URL(
      sessionId ? `./?session=${encodeURIComponent(sessionId)}` : './',
      self.location.href,
    ).href;
    await self.clients.openWindow(target);
  })());
});

/**
 * iOS expires and rotates push subscriptions on its own.
 *
 * Re-subscribing means telling the server, which means holding the bearer
 * token — which this worker must never do. So it wakes any open page and lets
 * it re-register; if nothing is open, syncPush() on the next launch repairs it.
 * The gap is real and is the documented degradation, not an oversight.
 */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientList) client.postMessage({ type: 'cr:push-resync' });
  })());
});
