/*
 * Applies the colour theme before first paint. A separate file because the CSP allows no inline
 * scripts. Preference ('light' | 'dark', absent = follow the system) lives in localStorage; the app
 * fires 'sheetah:theme' after changing it.
 */
;(function () {
  // Rebrand (Quarry → Sheetah): carry saved views, history and settings over to the new key names.
  try {
    // Snapshot the key list first: adding and removing keys while indexing would skip some.
    var legacy = []
    for (var i = 0; i < localStorage.length; i++) {
      var key = localStorage.key(i)
      if (key && key.indexOf('quarry:') === 0) legacy.push(key)
    }
    for (var j = 0; j < legacy.length; j++) {
      var k = legacy[j]
      var next = 'sheetah:' + k.slice(7)
      if (localStorage.getItem(next) === null) localStorage.setItem(next, localStorage.getItem(k))
      localStorage.removeItem(k)
    }
  } catch {
    /* storage blocked: nothing to carry over */
  }
  var root = document.documentElement
  var mq = window.matchMedia('(prefers-color-scheme: dark)')
  function pref() {
    try {
      return localStorage.getItem('sheetah:theme')
    } catch {
      return root.dataset.themePref || null // storage blocked: the app keeps the choice here
    }
  }
  function apply() {
    var p = pref()
    var dark = p === 'dark' || (p !== 'light' && mq.matches)
    root.dataset.theme = dark ? 'dark' : 'light'
    var meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', dark ? '#0c0d10' : '#eceef2')
  }
  apply()
  mq.addEventListener('change', apply)
  window.addEventListener('sheetah:theme', apply)
})()
