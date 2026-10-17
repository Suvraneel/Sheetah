import { deflateRawSync } from 'node:zlib'
import { expect, test } from '@playwright/test'
import { decodeSql, encodeSql } from '../../src/engine/share'

test.describe('share links', () => {
  test('round-trip, and anything malformed is refused', async () => {
    const sql = "SELECT city, sum(total) FROM orders WHERE note = 'ünïcode ✓' GROUP BY 1"
    const token = await encodeSql(sql)
    expect(token).toMatch(/^z[A-Za-z0-9_-]+$/)
    expect(await decodeSql(token)).toBe(sql)
    expect(await decodeSql('zNOTVALID')).toBeNull()
    expect(await decodeSql('x' + token.slice(1))).toBeNull()
  })

  test('a token that inflates past 100 KB is refused without inflating it all', async () => {
    const bomb = 'z' + deflateRawSync(Buffer.alloc(50_000_000, 32)).toString('base64url')
    const started = Date.now()
    expect(await decodeSql(bomb)).toBeNull()
    expect(Date.now() - started).toBeLessThan(2000)
    await expect(encodeSql('x'.repeat(200_000))).rejects.toThrow(/too long/)
  })
})
