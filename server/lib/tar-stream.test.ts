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
    const entries = await listTarEntries(
      createReadStream(fix('sample.tar')),
      'tar',
      { entryLimit: 10, byteLimit: big },
    )
    const names = entries.map(e => e.name)
    expect(names).toEqual(expect.arrayContaining([
      'd/a.txt', 'd/b.txt', 'd/c.txt',
    ]))
  })

  it('lists entries in tar.gz', async () => {
    const entries = await listTarEntries(
      createReadStream(fix('sample.tar.gz')),
      'gz',
      { entryLimit: 10, byteLimit: big },
    )
    const names = entries.map(e => e.name).sort()
    expect(names).toEqual(['d/', 'd/a.txt', 'd/b.txt', 'd/c.txt'])
  })

  it('lists entries in tar.xz', async () => {
    const entries = await listTarEntries(
      createReadStream(fix('sample.tar.xz')),
      'xz',
      { entryLimit: 10, byteLimit: big },
    )
    const names = entries.map(e => e.name).sort()
    expect(names).toEqual(['d/', 'd/a.txt', 'd/b.txt', 'd/c.txt'])
  })

  it('stops at entryLimit', async () => {
    const entries = await listTarEntries(
      createReadStream(fix('sample.tar')),
      'tar',
      { entryLimit: 2, byteLimit: big },
    )
    expect(entries).toHaveLength(2)
  })

  it('reports size on entries', async () => {
    const entries = await listTarEntries(
      createReadStream(fix('sample.tar')),
      'tar',
      { entryLimit: 10, byteLimit: big },
    )
    const a = entries.find(e => e.name === 'd/a.txt')
    expect(a?.size).toBe(6) // 'alpha\n'
  })
})
