/*
 * Dayspine service worker.
 *
 * Expo does not generate one, so this is hand-written and deliberately small.
 * Its only job is to make an installed Dayspine open and work with no network.
 *
 * The rules differ per request because the risk differs per request:
 *
 *   /_expo/static/**  content-hashed by Metro, so the URL changes whenever the
 *                     bytes change. Immutable — cache-first, never revalidate.
 *
 *   navigations       network-first, falling back to the cached shell. An SPA
 *                     that serves a *stale* shell cache-first will ask for JS
 *                     chunk hashes that no longer exist on the server and boot
 *                     to a white screen. Network-first means a user who is
 *                     online always gets the current shell; the cache only ever
 *                     answers when the network genuinely failed.
 *
 *   other same-origin stale-while-revalidate (icons, manifest, exercise art).
 *
 *   cross-origin      not touched at all. Supabase reads and writes must never
 *                     be answered from a cache — the sync engine's whole
 *                     correctness argument is that it talks to the real server.
 */

/**
 * The base this worker is serving, derived from where the worker itself lives.
 * Registered at `<base>/sw.js`, so `./` relative to it IS the app root — which
 * keeps this file correct whether the app is at a domain root or under a
 * GitHub Pages project subpath, with nothing to configure.
 */
const BASE = new URL('./', self.location).pathname;

const VERSION = 'v2';
const SHELL = `dayspine-shell-${VERSION}`;
const ASSETS = `dayspine-assets-${VERSION}`;
const KEEP = [SHELL, ASSETS];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.addAll([BASE, `${BASE}manifest.webmanifest`])),
  );
});

/*
 * Activate immediately, but ONLY when the app asks.
 *
 * A waiting worker normally sits idle until every tab is gone, which for an
 * installed PWA can be days. `UpdatePrompt` sends this when the user taps
 * Refresh — never automatically, because swapping code out from under a running
 * session can lose whatever they were part-way through.
 */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      // Drop every cache from a previous VERSION, so a deploy cannot leave the
      // browser holding two generations of the same app.
      await Promise.all(names.filter((n) => !KEEP.includes(n)).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

/** The shell, for when the network cannot answer a navigation. */
async function shellFallback() {
  const cache = await caches.open(SHELL);
  return (await cache.match(BASE)) ?? Response.error();
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // --- navigations: network first -----------------------------------------
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          /*
           * `cache: 'no-store'` is doing the real work here.
           *
           * A plain `fetch(request)` inside a service worker still goes through
           * the HTTP cache, and GitHub Pages serves index.html with
           * `Cache-Control: max-age=600`. So "network-first" quietly returned a
           * ten-minute-old shell — which points at the previous build's
           * content-hashed bundle, which is then served cache-first because its
           * URL has not changed. Net effect: a deploy took up to ten minutes to
           * reach an already-open app, and a test that reopened it immediately
           * saw the old version with no indication anything was stale.
           *
           * The shell is ~1 kB. Always fetching it fresh costs nothing and is
           * the only thing that makes a deploy visible on the next launch.
           */
          const fresh = await fetch(request.url, { cache: 'no-store' });
          const cache = await caches.open(SHELL);
          cache.put(BASE, fresh.clone());
          return fresh;
        } catch {
          return shellFallback();
        }
      })(),
    );
    return;
  }

  // --- hashed build output: cache first ------------------------------------
  if (url.pathname.startsWith(`${BASE}_expo/static/`)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(ASSETS);
        const hit = await cache.match(request);
        if (hit) return hit;

        const fresh = await fetch(request);
        if (fresh.ok) cache.put(request, fresh.clone());
        return fresh;
      })(),
    );
    return;
  }

  // --- everything else same-origin: stale while revalidate ------------------
  event.respondWith(
    (async () => {
      const cache = await caches.open(ASSETS);
      const hit = await cache.match(request);

      const network = fetch(request)
        .then((fresh) => {
          if (fresh.ok) cache.put(request, fresh.clone());
          return fresh;
        })
        .catch(() => hit ?? Response.error());

      return hit ?? network;
    })(),
  );
});
