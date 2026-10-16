import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// `vite preview` serves the same security headers as production (vercel.json), so local tests run
// under the real Content-Security-Policy. The dev server is left alone: HMR needs inline scripts.
const vercel = JSON.parse(readFileSync(new URL('./vercel.json', import.meta.url), 'utf8')) as {
  headers: { source: string; headers: { key: string; value: string }[] }[]
}
const securityHeaders = Object.fromEntries(
  vercel.headers.find((h) => h.source === '/(.*)')!.headers
    .filter((h) => h.key !== 'Strict-Transport-Security') // HSTS on localhost would be sticky and pointless
    .map((h) => [h.key, h.value]),
)

/** Lists every built file for the service worker to precache, versioned by content. */
function precacheManifest(): Plugin {
  let outDir = 'dist'
  return {
    name: 'quarry-precache-manifest',
    apply: 'build',
    configResolved(c) {
      outDir = c.build.outDir
    },
    closeBundle() {
      const files: string[] = []
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const p = join(dir, name)
          if (statSync(p).isDirectory()) walk(p)
          else files.push(relative(outDir, p).split('\\').join('/'))
        }
      }
      walk(outDir)
      const list = files.filter((f) => !/^(sw\.js|precache-manifest\.json)$/.test(f) && !f.endsWith('.map')).sort()
      const hash = createHash('sha256')
      for (const f of list) hash.update(f).update(readFileSync(join(outDir, f)))
      const version = hash.digest('hex').slice(0, 16)
      writeFileSync(join(outDir, 'precache-manifest.json'), JSON.stringify({ version, files: list }, null, 1))
    },
  }
}

/**
 * DuckDB's worker ships a sourcemap that points at Arrow sources outside its package (which aren't
 * published), so the dev server warns about every one of them. Serve the worker without its map
 * comment instead; the map was unusable anyway.
 */
function duckdbWorkerWithoutSourcemap(): Plugin {
  const worker = /[\\/]@duckdb[\\/]duckdb-wasm[\\/]dist[\\/]duckdb-browser-eh\.worker\.js$/
  return {
    name: 'quarry-duckdb-worker-no-sourcemap',
    apply: 'serve',
    load(id) {
      const file = id.split('?')[0]
      if (!worker.test(file)) return null
      return { code: readFileSync(file, 'utf8').replace(/\n\/\/# sourceMappingURL=\S+\s*$/, '\n'), map: null }
    },
  }
}

export default defineConfig({
  plugins: [react(), precacheManifest(), duckdbWorkerWithoutSourcemap()],
  preview: { headers: securityHeaders },
})
