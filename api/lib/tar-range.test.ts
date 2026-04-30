import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createReadStream } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listTarHeadersByRange, type RangeReader } from './tar-range.js'

const here = dirname(fileURLToPath(import.meta.url))
const fix = (name: string) => resolve(here, 'test-fixtures', name)

async function loadFixture(name: string): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of createReadStream(fix(name))) chunks.push(c as Buffer)
  return Buffer.concat(chunks)
}

function bufferReader(buf: Buffer): RangeReader {
  return async (start, length) => buf.subarray(start, start + length)
}

let tarBuf: Buffer

beforeAll(async () => { tarBuf = await loadFixture('sample.tar') })
afterAll(() => {})

describe('listTarHeadersByRange', () => {
  it('lists all entries from a small tar via byte-range reads', async () => {
    const calls: string[] = []
    const r = await listTarHeadersByRange(
      bufferReader(tarBuf),
      { entryLimit: 10 },
      e => calls.push(e.name),
    )
    expect(r.entries.map(e => e.name).sort())
      .toEqual(['d/', 'd/a.txt', 'd/b.txt', 'd/c.txt'])
    expect(r.hasMore).toBe(false)
    expect(calls).toEqual(r.entries.map(e => e.name))
  })

  it('reads file sizes correctly', async () => {
    const r = await listTarHeadersByRange(
      bufferReader(tarBuf),
      { entryLimit: 10 },
    )
    const a = r.entries.find(e => e.name === 'd/a.txt')
    expect(a?.size).toBe(6) // 'alpha\n'
  })

  it('respects entryLimit and reports hasMore', async () => {
    const r = await listTarHeadersByRange(
      bufferReader(tarBuf),
      { entryLimit: 2 },
    )
    expect(r.entries).toHaveLength(2)
    expect(r.hasMore).toBe(true)
  })

  it('paginates with offset', async () => {
    const r1 = await listTarHeadersByRange(bufferReader(tarBuf), { entryLimit: 2, offset: 0 })
    const r2 = await listTarHeadersByRange(bufferReader(tarBuf), { entryLimit: 2, offset: 2 })
    expect(r1.entries).toHaveLength(2)
    expect(r2.entries).toHaveLength(2)
    const names = [...r1.entries, ...r2.entries].map(e => e.name).sort()
    expect(names).toEqual(['d/', 'd/a.txt', 'd/b.txt', 'd/c.txt'])
    expect(r2.hasMore).toBe(false)
  })

  it('issues few range reads when entries are tiny (no body draining)', async () => {
    let reads = 0
    const counting: RangeReader = async (start, length) => {
      reads++
      return tarBuf.subarray(start, start + length)
    }
    await listTarHeadersByRange(counting, { entryLimit: 10 })
    // The whole archive fits in a single 256 KB chunk, so the cache should
    // serve every header from one read (proves we're not draining bodies).
    expect(reads).toBeLessThanOrEqual(2)
  })
})
