// Downloads the DuckDB-WASM extensions Sheetah needs (parquet, json) into public/, so the site serves
// them itself. The app never fetches code from anywhere else at runtime (the engine is sealed and
// the CSP only allows this origin), so these files are the only way those formats work.
//
// Integrity, in two layers:
//   1. scripts/duckdb-extensions.lock.json pins a SHA-256 for every file. A mismatch fails the build.
//      The first build on a new DuckDB version records the hashes: commit the lock file.
//   2. DuckDB itself refuses extensions without a valid DuckDB signature (allow_unsigned_extensions
//      is off and the engine's configuration is locked).
//
// On CI/Vercel a missing extension fails the build (set SHEETAH_ALLOW_MISSING_EXTENSIONS=1 to ship
// without Parquet/JSON). Locally it just warns.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const LOCK = join(root, 'scripts/duckdb-extensions.lock.json')
const EXTENSIONS = ['parquet', 'json']
const PLATFORM = 'wasm_eh'
// QUARRY_ALLOW_MISSING_EXTENSIONS is the pre-rebrand name, still honoured.
const strict = (process.env.CI || process.env.VERCEL) && !(process.env.SHEETAH_ALLOW_MISSING_EXTENSIONS || process.env.QUARRY_ALLOW_MISSING_EXTENSIONS)

function coreVersion() {
  if (process.env.DUCKDB_VERSION) return process.env.DUCKDB_VERSION
  // The wasm binary embeds the version strings it knows about; the newest is its own.
  const bin = readFileSync(join(root, 'node_modules/@duckdb/duckdb-wasm/dist/duckdb-eh.wasm')).toString('latin1')
  const found = [...new Set(bin.match(/v1\.\d+\.\d+/g) ?? [])]
  found.sort((a, b) => {
    const pa = a.slice(1).split('.').map(Number)
    const pb = b.slice(1).split('.').map(Number)
    return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2]
  })
  return found.at(-1)
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const lock = existsSync(LOCK) ? JSON.parse(readFileSync(LOCK, 'utf8')) : {}
let lockChanged = false
let failures = 0

const version = coreVersion()
if (!version) {
  console.error('[extensions] Could not detect the DuckDB version.')
  process.exit(strict ? 1 : 0)
}

for (const name of EXTENSIONS) {
  const rel = `${version}/${PLATFORM}/${name}.duckdb_extension.wasm`
  const out = join(root, 'public/duckdb-extensions', rel)
  let buf
  try {
    if (existsSync(out)) {
      buf = readFileSync(out)
    } else {
      const res = await fetch(`https://extensions.duckdb.org/${rel}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      buf = Buffer.from(await res.arrayBuffer())
    }
  } catch (e) {
    failures++
    console[strict ? 'error' : 'warn'](`[extensions] ${name}: ${e.message}. Parquet/JSON won't be available in this build.`)
    continue
  }

  const hash = sha256(buf)
  const pinned = lock[rel]
  if (pinned && pinned !== hash) {
    console.error(`[extensions] ${name}: SHA-256 mismatch for ${rel}\n  expected ${pinned}\n  got      ${hash}\nRefusing to build.`)
    process.exit(1)
  }
  if (!pinned) {
    lock[rel] = hash
    lockChanged = true
    console.warn(`[extensions] ${name}: pinned new hash ${hash.slice(0, 16)}… (commit scripts/duckdb-extensions.lock.json)`)
  }
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, buf)
  console.log(`[extensions] ${name} ${version} ✓ ${hash.slice(0, 12)}`)
}

if (lockChanged) writeFileSync(LOCK, JSON.stringify(lock, null, 2) + '\n')
if (failures && strict) {
  console.error('[extensions] Missing extensions on CI. Set SHEETAH_ALLOW_MISSING_EXTENSIONS=1 to deploy without Parquet/JSON.')
  process.exit(1)
}
