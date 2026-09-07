const CACHE_VERSION = 'onchou-v17';

// The whole app shell plus data/words.json are precached -- unlike jed/
// kotoba (which have large on-demand data/ trees), onchou's entire dataset
// is one small flat JSON file, so there's no reason not to precache it.
const CORE_ASSETS = [
  '.',
  'index.html',
  'tutorial/',
  'tutorial/index.html',
  'style.css',
  'manifest.json',
  'icon.svg',
  'js/pitch-diagram.js',
  'js/reference-audio.js',
  'js/pitch-detect.js',
  'js/mora-segment.js',
  'js/pitch-contour.js',
  'js/settings.js',
  'js/word-select.js',
  'js/app.js',
  'data/words.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(CORE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

// Stale-while-revalidate for every same-origin GET -- keeps CORE_ASSETS
// fresh after the first load and opportunistically covers anything else
// same-origin without needing to list it explicitly above.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // Never intercept requests for the SW script itself -- otherwise a
  // page-level `fetch('/sw.js')`, including one the registration/update
  // flow could make indirectly, would be answered out of this same cache
  // instead of hitting the network, defeating the browser's own
  // update-detection.
  if (url.pathname.endsWith('/sw.js')) return;

  // A navigation whose response is an HTTP redirect (e.g. `/tutorial` ->
  // `/tutorial/`, which every static host emits for a directory URL without
  // its trailing slash) cannot be handed back through respondWith(): the
  // browser rejects a redirected response for a navigate-mode request and
  // fails the load outright (ERR_FAILED). Re-issue it as a synthesized
  // redirect so the browser performs the hop itself and re-requests the
  // canonical URL, which this handler then serves normally.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        try {
          const response = await fetch(event.request);
          if (response.redirected) return Response.redirect(response.url, 302);
          if (response.ok) {
            const cache = await caches.open(CACHE_VERSION);
            cache.put(event.request, response.clone());
          }
          return response;
        } catch (err) {
          return (await caches.match('index.html')) || Response.error();
        }
      })()
    );
    return;
  }

  event.respondWith(
    caches.open(CACHE_VERSION).then(async (cache) => {
      const cached = await cache.match(event.request);
      const network = fetch(event.request)
        .then((response) => {
          if (response.ok) cache.put(event.request, response.clone());
          return response;
        })
        .catch(() => null);
      // Keep the revalidation fetch (and its cache.put) alive even after we
      // hand back `cached` below -- without waitUntil() here, the browser is
      // free to terminate this worker as soon as the respondWith() promise
      // settles, and the network half of stale-while-revalidate may never
      // finish. Also fall back to a synthesized network-error Response
      // instead of `undefined` when there's neither a cached entry nor a
      // successful fetch (fully offline, resource never fetched before) --
      // resolving respondWith() with undefined throws instead of failing
      // the request cleanly.
      event.waitUntil(network);
      return cached || (await network) || Response.error();
    })
  );
});
