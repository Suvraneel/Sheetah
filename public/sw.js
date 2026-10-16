/*
 * Quarry service worker: makes the whole app (UI, DuckDB engine, extensions) available offline after
 * the first visit. It only ever talks to this origin. The list of files comes from
 * precache-manifest.json, generated at build time (see vite.config.ts).
 */
const PREFIX = 'quarry-'

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const res = await fetch('precache-manifest.json', { cache: 'no-store' })
      const { version, files } = await res.json()
      const cache = await caches.open(PREFIX + version)
      // Add one by one so a single failure doesn't abort the rest; the shell is required.
      await cache.add(new Request('./', { cache: 'reload' }))
      for (const file of files) {
        try {
          await cache.add(new Request(file, { cache: 'reload' }))
        } catch {
          /* optional asset (e.g. an extension not in this build) */
        }
      }
      await cache.put('quarry-version', new Response(version))
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const current = await currentCacheName()
      for (const key of await caches.keys()) if (key.startsWith(PREFIX) && key !== current) await caches.delete(key)
      await self.clients.claim()
    })(),
  )
})

async function currentCacheName() {
  for (const key of await caches.keys()) {
    if (!key.startsWith(PREFIX)) continue
    const cache = await caches.open(key)
    if (await cache.match('quarry-version')) return key
  }
  return null
}

self.addEventListener('fetch', (event) => {
  const req = event.request
  const url = new URL(req.url)
  if (req.method !== 'GET' || url.origin !== self.location.origin) return

  // Pages: network first (fresh deploys win), cached shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return await fetch(req)
        } catch {
          const cached = (await caches.match('./', { ignoreVary: true })) || (await caches.match('index.html', { ignoreVary: true }))
          return cached || Response.error()
        }
      })(),
    )
    return
  }

  // Hashed assets and pinned extensions never change: cache first.
  if (url.pathname.includes('/assets/') || url.pathname.includes('/duckdb-extensions/')) {
    event.respondWith((async () => (await caches.match(req, { ignoreVary: true })) || fetch(req))())
    return
  }

  // Everything else: network, falling back to cache.
  event.respondWith(
    (async () => {
      try {
        return await fetch(req)
      } catch {
        return (await caches.match(req, { ignoreVary: true })) || Response.error()
      }
    })(),
  )
})

self.addEventListener('message', async (event) => {
  if (event.data === 'status') {
    const name = await currentCacheName()
    event.source?.postMessage({ type: 'status', offlineReady: !!name })
  }
})
