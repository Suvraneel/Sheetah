import { tableToIPC } from 'apache-arrow'
import { getEngine, quoteIdent } from './db'

/*
 * Optional "keep my tables": snapshots tables as Arrow IPC files in the Origin Private File System
 * (OPFS), a per-site storage area other sites can't read. It's opt-in and off by default, because it
 * means your data now lives on disk in this browser (not encrypted). "Clear all local data" removes it.
 */
const DIR = 'quarry-tables'
export const MAX_PERSIST_ROWS = 5_000_000

export const persistSupported = () => typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory

async function folder(create = true) {
  const root = await navigator.storage.getDirectory()
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

/** Loads every saved table back into the engine. Returns the names restored. */
export async function restoreAll(): Promise<string[]> {
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
      await conn.query(`DROP TABLE IF EXISTS ${quoteIdent(name)}`)
      await conn.insertArrowFromIPCStream(bytes, { name, create: true })
      restored.push(name)
    } catch {
      /* skip a damaged snapshot rather than blocking start-up */
    }
  }
  return restored
}

export async function clearSaved(): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory()
    await root.removeEntry(DIR, { recursive: true })
  } catch {
    /* nothing saved */
  }
}
