/*
 * Applies the colour theme before first paint. A separate file because the CSP allows no inline
 * scripts. Preference ('light' | 'dark', absent = follow the system) lives in localStorage; the app
 * fires 'quarry:theme' after changing it.
 */
;(function () {
  var root = document.documentElement
  var mq = window.matchMedia('(prefers-color-scheme: dark)')
  function pref() {
    try {
      return localStorage.getItem('quarry:theme')
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
  window.addEventListener('quarry:theme', apply)
})()
