/*
 * Runs before the app (a classic script, so even browsers that can't load the app's modules run it).
 * Sheetah needs WebAssembly with exception handling, 64-bit integer arrays and workers. If any is
 * missing, explain that plainly instead of showing a blank page or a spinner that never finishes.
 */
;(function () {
  var reason = null
  try {
    if (typeof WebAssembly !== 'object') reason = 'WebAssembly'
    else if (typeof BigInt64Array === 'undefined') reason = '64-bit integers'
    else if (typeof Worker === 'undefined') reason = 'Web Workers'
    else {
      // The smallest module that uses a try/catch block: valid only where wasm exceptions are supported.
      var eh = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 8, 1, 6, 0, 6, 64, 25, 11, 11])
      if (!WebAssembly.validate(eh)) reason = 'WebAssembly exception handling'
    }
  } catch (e) { // eslint-disable-line no-unused-vars -- a binding: old browsers reject a bare catch
    reason = 'WebAssembly'
  }
  if (!reason) return
  window.__sheetahUnsupported = reason
  function show() {
    var root = document.getElementById('root')
    if (!root) return
    root.innerHTML =
      '<main style="max-width:560px;margin:12vh auto;padding:0 24px;font:16px/1.6 system-ui,sans-serif">' +
      '<h1 style="font-size:28px;letter-spacing:-0.02em;margin:0 0 12px">Sheetah needs a newer browser</h1>' +
      '<p>Sheetah runs a full database inside this tab, and this browser is missing ' +
      reason +
      ', which it needs.</p>' +
      '<p>It works in current versions of <b>Chrome</b>, <b>Edge</b>, <b>Firefox</b> and <b>Safari</b> ' +
      '(Chrome/Edge 111+, Firefox 114+, Safari 16.4+), on desktop and mobile.</p>' +
      '<p style="color:#666">Nothing was uploaded: Sheetah never sends your files anywhere.</p></main>'
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show)
  else show()
})()
