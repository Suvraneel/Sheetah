import { tableToIPC } from 'apache-arrow'
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

export async function saveTable(name: string): Promise<void> {
  const { conn } = await getEngine()
  const arrow = await conn.query(`SELECT * FROM ${quoteIdent(name)}`)
  const bytes = tableToIPC(arrow, 'stream')
  const dir = await folder()
  const handle = await dir.getFileHandle(fileName(name), { create: true })
  const writable = await handle.createWritable()
  await writable.write(bytes as Uint8Array<ArrayBuffer>)
  await writable.close()
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
      const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer())
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
