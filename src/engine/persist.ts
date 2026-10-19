import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm'
import { RecordBatchStreamWriter } from 'apache-arrow'
import { getEngine, quoteIdent, quoteLiteral, withRunLock } from './db'

/*
 * Optional "keep my tables": snapshots tables as Arrow IPC files in the Origin Private File System
 * (OPFS), a per-site storage area other sites can't read. It's opt-in and off by default, because it
 * means your data now lives on disk in this browser (not encrypted). "Clear all local data" removes it.
 */
const DIR = 'sheetah-tables'
export const MAX_PERSIST_ROWS = 5_000_000

/** OPFS with writable file handles (Safari before 26 has the folder API but can't write files from the page). */
export const persistSupported = () =>
  typeof navigator !== 'undefined' &&
  !!navigator.storage?.getDirectory &&
  typeof FileSystemFileHandle !== 'undefined' &&
  'createWritable' in FileSystemFileHandle.prototype

const LEGACY_DIR = 'quarry-tables' // before the rebrand to Sheetah
let migrated: Promise<void> | null = null

/** Copies snapshots from the pre-rebrand folder into the current one (once), then removes it. */
function migrateLegacyFolder(root: FileSystemDirectoryHandle) {
  migrated ??= (async () => {
    let old: FileSystemDirectoryHandle
    try {
      old = await root.getDirectoryHandle(LEGACY_DIR)
    } catch {
      return // nothing to carry over
    }
    const dir = await root.getDirectoryHandle(DIR, { create: true })
    for await (const [name, handle] of old as unknown as AsyncIterable<[string, FileSystemHandle]>) {
      if (handle.kind !== 'file') continue
      const exists = await dir.getFileHandle(name).then(() => true, () => false)
      if (exists) continue
      const file = await (handle as FileSystemFileHandle).getFile()
      const out = await (await dir.getFileHandle(name, { create: true })).createWritable()
      await out.write(await file.arrayBuffer())
      await out.close()
    }
    await root.removeEntry(LEGACY_DIR, { recursive: true })
  })().catch(() => {})
  return migrated
}

async function folder(create = true) {
  const root = await navigator.storage.getDirectory()
  await migrateLegacyFolder(root)
  return root.getDirectoryHandle(DIR, { create })
}

const fileName = (table: string) => `${encodeURIComponent(table)}.arrow`
const tableName = (file: string) => decodeURIComponent(file.replace(/\.arrow$/, ''))

/**
 * Writes a table's snapshot batch by batch, from the engine to the file: it never sits whole in the page's
 * memory (a 2.5M-row table read in at once, then copied to bytes, took the tab past its memory). The file's
 * writer replaces the old snapshot only when it closes, so a reload part-way through keeps the one before; a
 * new snapshot that didn't finish is removed (an empty file isn't restored either).
 */
export async function saveTable(name: string): Promise<void> {
  const { db } = await getEngine()
  // A connection of its own: a streamed read is abandoned if another query arrives on its connection.
  const conn = await db.connect()
  try {
    await stream(conn, name)
  } finally {
    await conn.close().catch(() => {})
  }
}

async function stream(conn: AsyncDuckDBConnection, name: string): Promise<void> {
  const dir = await folder()
  const file = fileName(name)
  const existed = await dir.getFileHandle(file).then(() => true, () => false)
  const out = await (await dir.getFileHandle(file, { create: true })).createWritable()
  try {
    // ENUM columns as text: streamed, their dictionaries come through empty (and the snapshot wouldn't restore).
    const types = (await conn.query(`DESCRIBE ${quoteIdent(name)}`)).toArray().map((r) => r.toJSON() as { column_name: string; column_type: string })
    const enums = types.filter((t) => /^ENUM\(/i.test(t.column_type)).map((t) => `${quoteIdent(t.column_name)}::VARCHAR AS ${quoteIdent(t.column_name)}`)
    const reader = await conn.send(`SELECT *${enums.length ? ` REPLACE (${enums.join(', ')})` : ''} FROM ${quoteIdent(name)}`, true)
    const writer = new RecordBatchStreamWriter()
    let written = 0
    // A write that fails (the disk full) stops everything: never a wait for bytes that will never be written.
    let failed: unknown = null
    const pump = (async () => {
      for await (const chunk of writer) {
        await out.write(chunk as Uint8Array<ArrayBuffer>)
        written += chunk.byteLength
      }
    })().catch((e: unknown) => {
      failed = e ?? new Error('Writing the snapshot failed')
    })
    // How far the writer has got (its own count of bytes queued): the engine waits while the disk catches up.
    const queued = () => (writer as unknown as { _position: number })._position
    let batches = 0
    for await (const batch of reader) {
      if (failed) break
      writer.write(batch)
      batches++
      while (!failed && queued() - written > 32 * 1024 ** 2) await new Promise((r) => setTimeout(r, 5))
    }
    if (failed) {
      await reader.cancel?.().catch(() => {})
      throw failed
    }
    // No rows: the columns alone, so it comes back as the empty table it is.
    if (!batches) writer.reset(undefined, reader.schema)
    writer.close()
    await pump
    if (failed) throw failed
    await out.close()
  } catch (e) {
    await out.abort().catch(() => {})
    if (!existed) await dir.removeEntry(file).catch(() => {})
    throw e
  }
}

export async function removeTable(name: string): Promise<void> {
  try {
    await (await folder(false)).removeEntry(fileName(name))
  } catch {
    /* already gone */
  }
}

export async function listSaved(): Promise<string[]> {
  try {
    const dir = await folder(false)
    const names: string[] = []
    for await (const [file] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
      if (file.endsWith('.arrow')) names.push(tableName(file))
    }
    return names.sort()
  } catch {
    return []
  }
}

/** Loads every saved table back into the engine (before any file the user drops in meanwhile). Returns the names restored. */
export function restoreAll(): Promise<string[]> {
  return withRunLock(restoreLocked)
}

async function restoreLocked(): Promise<string[]> {
  const { conn } = await getEngine()
  const restored: string[] = []
  let dir: FileSystemDirectoryHandle
  try {
    dir = await folder(false)
  } catch {
    return restored
  }
  for await (const [file, handle] of dir as unknown as AsyncIterable<[string, FileSystemFileHandle]>) {
    if (!file.endsWith('.arrow')) continue
    const name = tableName(file)
    try {
      const snapshot = await handle.getFile()
      // An empty file is a save that never finished (the tab closed first): nothing to restore, and removed.
      if (!snapshot.size) {
        await dir.removeEntry(file).catch(() => {})
        continue
      }
      const bytes = new Uint8Array(await snapshot.arrayBuffer())
      // Never replace a table that already exists (the user may have opened a file with that name).
      const exists = (await conn.query(`SELECT 1 FROM information_schema.tables WHERE table_schema = 'main' AND lower(table_name) = lower(${quoteLiteral(name)})`)).numRows > 0
      if (exists) continue
      await conn.insertArrowFromIPCStream(bytes, { name, create: true })
      restored.push(name)
    } catch {
      /* skip a damaged snapshot rather than blocking start-up */
    }
  }
  return restored
}

export async function clearSaved(): Promise<void> {
  const root = await navigator.storage.getDirectory().catch(() => null)
  // Both folders: a pre-rebrand one that was never migrated must not come back later.
  for (const name of [DIR, LEGACY_DIR]) await root?.removeEntry(name, { recursive: true }).catch(() => {})
}
