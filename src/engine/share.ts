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

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream)
  return new Uint8Array(await new Response(out).arrayBuffer())
}

export async function encodeSql(sql: string): Promise<string> {
  const raw = new TextEncoder().encode(sql)
  if (typeof CompressionStream !== 'undefined') {
    return `z${toBase64Url(await pipe(raw, new CompressionStream('deflate-raw')))}`
  }
  return `p${toBase64Url(raw)}`
}

export async function decodeSql(token: string): Promise<string | null> {
  try {
    const body = fromBase64Url(token.slice(1))
    const bytes = token[0] === 'z' ? await pipe(body, new DecompressionStream('deflate-raw')) : token[0] === 'p' ? body : null
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
