/* A workbook's zip directory, read without unpacking anything (used by the Excel worker; unit-tested). */

/**
 * Each worksheet's size inside the workbook, from the zip's own directory at its end (nothing unpacked): the
 * reader takes a sheet in as one piece of text, and the browser can't hold one past about 512 MB.
 */
export async function sheetSizes(file: Blob): Promise<{ name: string; size: number }[]> {
  const tail = new DataView(await file.slice(Math.max(0, file.size - 65_557)).arrayBuffer())
  let end = -1
  for (let i = tail.byteLength - 22; i >= 0; i--)
    if (tail.getUint32(i, true) === 0x06054b50) {
      end = i
      break
    }
  if (end < 0) return []
  const size = tail.getUint32(end + 12, true)
  const offset = tail.getUint32(end + 16, true)
  if (offset === 0xffffffff || size === 0xffffffff) return [] // a ZIP64 workbook: left to the reader
  const dir = new DataView(await file.slice(offset, offset + size).arrayBuffer())
  const out: { name: string; size: number }[] = []
  const decoder = new TextDecoder()
  for (let at = 0; at + 46 <= dir.byteLength && dir.getUint32(at, true) === 0x02014b50; ) {
    const unpacked = dir.getUint32(at + 24, true)
    const [n, x, c] = [dir.getUint16(at + 28, true), dir.getUint16(at + 30, true), dir.getUint16(at + 32, true)]
    const name = decoder.decode(new Uint8Array(dir.buffer, dir.byteOffset + at + 46, n))
    if (/^xl\/worksheets\/[^/]+\.xml$/.test(name)) out.push({ name, size: unpacked === 0xffffffff ? Infinity : unpacked })
    at += 46 + n + x + c
  }
  return out
}

