/* Hisab Rep PWA — tiny runtime-caching service worker.
 * App shell: network-first (fresh HTML when online, cache when offline).
 * Static assets: cache-first. POST/PUT never intercepted (sync uses fetch API). */

const SHELL = "hisab-shell-v1";
const STATIC = "hisab-static-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => ![SHELL, STATIC].includes(k)).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // never cache sync/api endpoints
  if (url.pathname.startsWith("/api/")) return;

  if (url.pathname.startsWith("/_next/static/") || url.pathname === "/manifest.webmanifest" || url.pathname.startsWith("/icons/")) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            const copy = res.clone();
            caches.open(STATIC).then((c) => c.put(req, copy));
            return res;
          }),
      ),
    );
    return;
  }

  // documents: network-first, fallback to cache (offline app shell)
  event.respondWith(
    (async () => {
      try {
        const res = await fetch(req);
        if (res.ok && req.mode === "navigate") {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(req, copy));
        }
        return res;
      } catch (err) {
        const hit = await caches.match(req);
        if (hit) return hit;
        const appShell = await caches.match("/rep");
        if (appShell) return appShell;
        throw err;
      }
    })(),
  );
});
