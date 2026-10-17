/*
 * Share a query as a link. The SQL is compressed into the URL *fragment* (#q=…), which browsers never
 * send to the server, so even the host doesn't see shared queries. Only SQL is shared, never data.
 * Opening a link never runs anything: the query is shown for review first (and the sealed engine
 * can't reach the network even if it's malicious).
 */
const MAX_SQL = 100_000

const toBase64Url = (bytes: Uint8Array) => {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const fromBase64Url = (s: string) => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

/** Runs bytes through a (de)compression stream, giving up as soon as the output passes `limit` bytes. */
async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream, limit = Infinity): Promise<Uint8Array | null> {
  const reader = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream).getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    // A tiny link can inflate to gigabytes (a "zip bomb"): stop reading instead of filling memory.
    if (size > limit) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}

/** Longest token accepted from a URL: 100 KB of SQL never compresses to more than this. */
const MAX_TOKEN = Math.ceil((MAX_SQL * 4) / 3) + 1024

export async function encodeSql(sql: string): Promise<string> {
  const raw = new TextEncoder().encode(sql)
  if (raw.length > MAX_SQL) throw new Error('That query is too long to share as a link (over 100 KB).')
  if (typeof CompressionStream !== 'undefined') {
    const packed = await pipe(raw, new CompressionStream('deflate-raw'))
    if (packed) return `z${toBase64Url(packed)}`
  }
  return `p${toBase64Url(raw)}`
}

export async function decodeSql(token: string): Promise<string | null> {
  try {
    if (token.length > MAX_TOKEN) return null
    const body = fromBase64Url(token.slice(1))
    const bytes = token[0] === 'z' ? await pipe(body, new DecompressionStream('deflate-raw'), MAX_SQL) : token[0] === 'p' ? body : null
    if (!bytes || bytes.length > MAX_SQL) return null
    const sql = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim()
    return sql || null
  } catch {
    return null
  }
}

export async function shareUrl(sql: string): Promise<string> {
  return `${location.origin}${location.pathname}#q=${await encodeSql(sql)}`
}

/** Reads (and removes) a shared query token from the current URL. */
export function takeSharedToken(): string | null {
  const m = location.hash.match(/^#q=([A-Za-z0-9_-]+)$/)
  if (!m) return null
  history.replaceState(null, '', location.pathname + location.search)
  return m[1]
}
