/**
 * Service worker: caches the app shell so the home-screen app opens instantly
 * and survives a dropped link, without ever caching session data.
 *
 * Hard rule: /api/* and /ws are never read from or written to the cache. A
 * stale session list is misleading, and a cached 200 for an authenticated
 * endpoint would be a token-scoped response served to a later, tokenless load.
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
const VERSION = 'v3';
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
  './css/terminal.css',
  './js/main.js',
  './js/api.js',
  './js/ui.js',
  './js/kinds.js',
  './js/keybar.js',
  './js/session-term.js',
  './js/viewport.js',
  './js/views/sessions.js',
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
