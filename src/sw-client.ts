/*
 * Service-worker registration and updates. A new deploy installs in the background and waits; the app
 * shows "A new version is ready · Reload", and only a click swaps it in (open tables live in memory,
 * so reloading on our own would lose them).
 */
export const UPDATE_EVENT = 'sheetah:update-ready'

let waiting: ServiceWorker | null = null
/** Set when this tab asked for the swap (Reload) or swapped silently (same build): not news to announce. */
let expected: 'reload' | 'silent' | null = null
/** Another tab swapped in a new version: this tab still runs the old build until it reloads. */
let replacedElsewhere = false

function announce(worker: ServiceWorker | null) {
  waiting = worker
  window.dispatchEvent(new CustomEvent(UPDATE_EVENT))
}

export function updateReady() {
  return !!waiting || replacedElsewhere
}

/** Swaps in the waiting version and reloads once it has taken over. */
export function applyUpdate() {
  // Nothing left to swap (another tab already did, or the worker moved on): just load the new build.
  if (!waiting || waiting.state === 'activated' || waiting.state === 'redundant' || replacedElsewhere) return location.reload()
  expected = 'reload'
  waiting.postMessage('skip-waiting')
}

/** The hashed scripts and styles this tab was loaded with, relative to the site root ("assets/index-abc.js"). */
function buildFiles(): string[] {
  const base = new URL(import.meta.env.BASE_URL, location.href).pathname
  const urls = [import.meta.url, ...Array.from(document.querySelectorAll<HTMLScriptElement | HTMLLinkElement>('script[src], link[rel=stylesheet][href]'), (el) => ('src' in el ? el.src : el.href))]
  return [
    ...new Set(
      urls
        .map((u) => new URL(u, location.href))
        .filter((u) => u.origin === location.origin && u.pathname.startsWith(`${base}assets/`))
        .map((u) => u.pathname.slice(base.length)),
    ),
  ]
}

/** Asks a waiting worker whether it holds exactly the build this tab already runs. */
function covers(worker: ServiceWorker): Promise<boolean> {
  const paths = buildFiles()
  if (!paths.length) return Promise.resolve(false)
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    const timer = window.setTimeout(() => resolve(false), 3000)
    channel.port1.onmessage = (e) => {
      window.clearTimeout(timer)
      resolve(!!(e.data as { covered?: boolean } | null)?.covered)
    }
    worker.postMessage({ type: 'covers', paths }, [channel.port2])
  })
}

/** A new worker is installed and waiting: swap it in quietly if it's this very build, otherwise offer it. */
async function handleWaiting(worker: ServiceWorker) {
  if (await covers(worker)) {
    // The page was loaded from the network after a deploy: it already runs the new build.
    expected = 'silent'
    worker.postMessage('skip-waiting')
    return
  }
  announce(worker)
}

export function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
  window.addEventListener('load', async () => {
    try {
      let controller = navigator.serviceWorker.controller
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        const previous = controller
        controller = navigator.serviceWorker.controller
        if (!previous) return // the first install taking over: nothing changed for the user
        const why = expected
        expected = null
        if (why === 'reload') return location.reload()
        if (why === 'silent') return
        // Swapped from another tab: keep working (the old build's files stay cached), offer a reload.
        replacedElsewhere = true
        announce(null)
      })
      const reg = await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`)
      // Installed in an earlier visit and still waiting.
      if (reg.waiting && navigator.serviceWorker.controller) void handleWaiting(reg.waiting)
      reg.addEventListener('updatefound', () => {
        const next = reg.installing
        next?.addEventListener('statechange', () => {
          // "installed" with a controller present means an update (not the first install).
          if (next.state === 'installed' && navigator.serviceWorker.controller) void handleWaiting(next)
        })
      })
      // Long-lived tabs check for a new version every hour.
      window.setInterval(() => void reg.update().catch(() => {}), 60 * 60 * 1000)
    } catch {
      /* offline support is a bonus: the app works without it */
    }
  })
}

/** Tables are open in this tab: a reload would clear them (unless kept), so it's offered, never done. */
let hasWork = false
export const setHasWork = (on: boolean) => {
  hasWork = on
}

/**
 * After a deploy, an old tab can ask for a lazily loaded chunk that no longer exists. With nothing open
 * yet, reload once to pick up the new build (guarded so it can't loop). With tables open, the part that
 * needed it says it couldn't load, and the new version is offered instead.
 */
export function recoverFromStaleChunks() {
  window.addEventListener('vite:preloadError', (e) => {
    if (hasWork) {
      window.dispatchEvent(new Event(UPDATE_EVENT))
      return
    }
    try {
      if (sessionStorage.getItem('sheetah:reloaded-for-chunks')) return
      sessionStorage.setItem('sheetah:reloaded-for-chunks', '1')
    } catch {
      return
    }
    e.preventDefault()
    location.reload()
  })
}
