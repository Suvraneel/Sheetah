/*
 * Sheetah service worker: makes the whole app (UI, DuckDB engine, extensions) available offline after
 * the first visit. It only ever talks to this origin.
 *
 * Versioning: the build writes its content hash into VERSION below (vite.config.ts), so every deploy
 * changes these bytes and browsers install the new worker. A new version waits until the page says
 * "skip-waiting" (the user clicked Reload), so an open tab never loses its files mid-session.
 *
 * The previous version's cache is kept until the next deploy: another tab still running the old build
 * can keep loading its lazily loaded files after this one swaps the worker.
 */
const VERSION = '__SHEETAH_BUILD__'
const PREFIX = 'sheetah-'
const CACHE = PREFIX + VERSION
const META = 'sheetah_meta' // which version cache is current (not a version cache itself)
const LEGACY_PREFIX = 'quarry-' // caches from before the rebrand to Sheetah

/** Looks in this version's cache first, then in any (an older tab may ask for its own build's files). */
const lookup = async (req, anyVersion) =>
  (await (await caches.open(CACHE)).match(req, { ignoreVary: true })) || (anyVersion ? await caches.match(req, { ignoreVary: true }) : undefined)

/** Hashed build files and pinned extensions never change under the same name. */
const immutable = (path) => /(^|\/)(assets|duckdb-extensions)\//.test(path)

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const res = await fetch('precache-manifest.json', { cache: 'no-store' })
      const { files } = await res.json()
      const cache = await caches.open(CACHE)
      await cache.add(new Request('./', { cache: 'reload' }))
      // The file list, so a page can ask whether this version is the build it already runs.
      await cache.put('precache-manifest.json', new Response(JSON.stringify({ files }), { headers: { 'content-type': 'application/json' } }))
      for (const file of files) {
        // Unchanged hashed files are copied from the previous version's cache: a deploy doesn't
        // re-download the 8 MB engine.
        const old = immutable(file) ? await caches.match(file, { ignoreVary: true }) : undefined
        if (old) {
          await cache.put(file, old)
          continue
        }
        try {
          await cache.add(new Request(file, { cache: immutable(file) ? 'default' : 'reload' }))
        } catch (e) {
          // App files are required (an incomplete cache would break offline use); extensions are optional.
          if (/^assets\//.test(file)) throw e
        }
      }
      // First install: take over right away. Updates wait for the page to ask (see 'message').
      if (!self.registration.active) await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const meta = await caches.open(META)
      const was = await meta.match('current')
      const previous = was ? await was.text() : null
      await meta.put('current', new Response(CACHE))
      for (const key of await caches.keys()) {
        const stale = key.startsWith(PREFIX) && key !== CACHE && key !== previous
        if (stale || key.startsWith(LEGACY_PREFIX)) await caches.delete(key)
      }
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  const url = new URL(req.url)
  if (req.method !== 'GET' || url.origin !== self.location.origin) return

  // Pages: network first (fresh deploys win). Offline or when the server is failing: the page itself
  // if it's cached (privacy.html), otherwise the app shell.
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cached = async () => (await lookup(req)) || (await lookup('./')) || (await lookup('index.html'))
        try {
          const res = await fetch(req)
          if (res.status >= 500) return (await cached()) || res
          return res
        } catch {
          return (await cached()) || Response.error()
        }
      })(),
    )
    return
  }

  // Hashed assets and pinned extensions never change: cache first.
  if (immutable(url.pathname.replace(/^\//, ''))) {
    event.respondWith((async () => (await lookup(req, true)) || fetch(req))())
    return
  }

  // Everything else: network, falling back to cache.
  event.respondWith(
    (async () => {
      try {
        return await fetch(req)
      } catch {
        return (await lookup(req, true)) || Response.error()
      }
    })(),
  )
})

self.addEventListener('message', async (event) => {
  if (event.data === 'skip-waiting') {
    await self.skipWaiting()
    return
  }
  // "Is this the build I'm running?" The page sends its hashed scripts and styles; if this version has
  // every one of them, swapping workers changes nothing the user can see, so no reload is needed.
  if (event.data?.type === 'covers') {
    let covered = false
    try {
      const res = await (await caches.open(CACHE)).match('precache-manifest.json')
      const { files } = res ? await res.json() : { files: [] }
      const paths = Array.isArray(event.data.paths) ? event.data.paths : []
      covered = paths.length > 0 && paths.every((p) => files.includes(p))
    } catch {
      /* unknown: treat as a different build */
    }
    event.ports[0]?.postMessage({ covered })
    return
  }
  if (event.data === 'status') {
    event.source?.postMessage({ type: 'status', offlineReady: await caches.has(CACHE), version: VERSION })
  }
})
