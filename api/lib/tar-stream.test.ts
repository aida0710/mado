import { describe, expect, it } from 'vitest'
import { createReadStream } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listTarEntries } from './tar-stream.js'

const here = dirname(fileURLToPath(import.meta.url))
const fix = (name: string) => resolve(here, 'test-fixtures', name)

const big = 1_000_000

describe('listTarEntries', () => {
  it('lists entries in plain tar', async () => {
    const r = await listTarEntries(
      createReadStream(fix('sample.tar')),
      'tar',
      { entryLimit: 10, byteLimit: big },
    )
    expect(r.truncated).toBe(false)
    expect(r.hasMore).toBe(false)
    expect(r.entries.map(e => e.name)).toEqual(expect.arrayContaining([
      'd/a.txt', 'd/b.txt', 'd/c.txt',
    ]))
  })

  it('lists entries in tar.gz', async () => {
    const r = await listTarEntries(
      createReadStream(fix('sample.tar.gz')),
      'gz',
      { entryLimit: 10, byteLimit: big },
    )
    expect(r.truncated).toBe(false)
    expect(r.hasMore).toBe(false)
    expect(r.entries.map(e => e.name).sort())
      .toEqual(['d/', 'd/a.txt', 'd/b.txt', 'd/c.txt'])
  })

  it('lists entries in tar.xz', async () => {
    const r = await listTarEntries(
      createReadStream(fix('sample.tar.xz')),
      'xz',
      { entryLimit: 10, byteLimit: big },
    )
    expect(r.truncated).toBe(false)
    expect(r.hasMore).toBe(false)
    expect(r.entries.map(e => e.name).sort())
      .toEqual(['d/', 'd/a.txt', 'd/b.txt', 'd/c.txt'])
  })

  it('stops at entryLimit and signals hasMore', async () => {
    const r = await listTarEntries(
      createReadStream(fix('sample.tar')),
      'tar',
      { entryLimit: 2, byteLimit: big },
    )
    expect(r.entries).toHaveLength(2)
    expect(r.hasMore).toBe(true)
    // entryLimit に達しても "truncated" ではない — ページネーションで回復できる。
    expect(r.truncated).toBe(false)
  })

  it('paginates with offset', async () => {
    // sample.tar.gz には 4 エントリある: d/, d/a.txt, d/b.txt, d/c.txt
    const page1 = await listTarEntries(
      createReadStream(fix('sample.tar.gz')),
      'gz',
      { entryLimit: 2, byteLimit: big, offset: 0 },
    )
    expect(page1.entries).toHaveLength(2)
    expect(page1.hasMore).toBe(true)

    const page2 = await listTarEntries(
      createReadStream(fix('sample.tar.gz')),
      'gz',
      { entryLimit: 2, byteLimit: big, offset: 2 },
    )
    expect(page2.entries).toHaveLength(2)
    expect(page2.hasMore).toBe(false)

    const allNames = [...page1.entries, ...page2.entries].map(e => e.name).sort()
    expect(allNames).toEqual(['d/', 'd/a.txt', 'd/b.txt', 'd/c.txt'])
  })

  it('offset past the end returns empty without hasMore', async () => {
    const r = await listTarEntries(
      createReadStream(fix('sample.tar.gz')),
      'gz',
      { entryLimit: 100, byteLimit: big, offset: 100 },
    )
    expect(r.entries).toEqual([])
    expect(r.hasMore).toBe(false)
  })

  it('stops at byteLimit and marks truncated', async () => {
    // 展開後の sample.tar.xz は 50 バイトを超える。バイトカウンタは
    // デコンプレッサの後に位置するため、展開後のストリームで強制される。
    const r = await listTarEntries(
      createReadStream(fix('sample.tar.xz')),
      'xz',
      { entryLimit: 10, byteLimit: 50 },
    )
    expect(r.truncated).toBe(true)
    expect(r.entries.length).toBeLessThan(4)
  })

  it('reports size on entries', async () => {
    const r = await listTarEntries(
      createReadStream(fix('sample.tar')),
      'tar',
      { entryLimit: 10, byteLimit: big },
    )
    const a = r.entries.find(e => e.name === 'd/a.txt')
    expect(a?.size).toBe(6) // 'alpha\n' の長さ
  })
})
