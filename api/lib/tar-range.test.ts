import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createReadStream } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listTarHeadersByRange, TarRangeIndex, type RangeReader } from './tar-range.js'
import { createVirtualTar } from './test-fixtures/virtual-tar.js'

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

describe('listTarHeadersByRange', () => {
  it('小さい tar の全エントリを Range 読みで列挙する', async () => {
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

  it('各ファイルのサイズを正しく読む', async () => {
    const r = await listTarHeadersByRange(
      bufferReader(tarBuf),
      { entryLimit: 10 },
    )
    const a = r.entries.find(e => e.name === 'd/a.txt')
    expect(a?.size).toBe(6) // 'alpha\n' の長さ
  })

  it('entryLimit で止まり、hasMore を立てる', async () => {
    const r = await listTarHeadersByRange(
      bufferReader(tarBuf),
      { entryLimit: 2 },
    )
    expect(r.entries).toHaveLength(2)
    expect(r.hasMore).toBe(true)
  })

  it('offset で次のページを返す', async () => {
    const r1 = await listTarHeadersByRange(bufferReader(tarBuf), { entryLimit: 2, offset: 0 })
    const r2 = await listTarHeadersByRange(bufferReader(tarBuf), { entryLimit: 2, offset: 2 })
    expect(r1.entries).toHaveLength(2)
    expect(r2.entries).toHaveLength(2)
    const names = [...r1.entries, ...r2.entries].map(e => e.name).sort()
    expect(names).toEqual(['d/', 'd/a.txt', 'd/b.txt', 'd/c.txt'])
    expect(r2.hasMore).toBe(false)
  })

  it('小さいエントリが並ぶtarは少数の部分取得で列挙できる', async () => {
    let reads = 0
    const counting: RangeReader = async (start, length) => {
      reads++
      return tarBuf.subarray(start, start + length)
    }
    await listTarHeadersByRange(counting, { entryLimit: 10 })
    // アーカイブ全体が 256 KB のチャンクに収まるため、キャッシュは
    // 1回の読み込みからすべてのヘッダーを提供するはず (本体をドレインしていないことの証明)。
    expect(reads).toBeLessThanOrEqual(2)
  })
})

describe('tarの位置索引', () => {
  it.each([1, 10] as const)('%iGiBの本文を飛ばして後ろのファイルを見つける', async gigabytes => {
    const tar = createVirtualTar(gigabytes)
    const read = vi.fn(tar.read)
    const index = new TarRangeIndex(read)
    const entry = await index.find('d/a.txt')
    expect(entry?.size).toBe(6)
    expect((await tar.read(entry!.bodyOffset, entry!.size)).toString()).toBe('alpha\n')
    expect(read).toHaveBeenCalledTimes(2)
    expect(read.mock.calls.every(([, length]) => length <= 256 * 1024)).toBe(true)
  })

  it('一覧と本文取得を同時に呼んでも索引が重複・欠落しない', async () => {
    const tar = createVirtualTar()
    const read = vi.fn(tar.read)
    const index = new TarRangeIndex(read)
    const [listing, entry] = await Promise.all([
      index.list({ entryLimit: 100 }), index.find('d/c.txt'),
    ])
    expect(listing.entries.map(file => file.name).sort()).toEqual(['d/', 'd/a.txt', 'd/b.txt', 'd/c.txt', 'large.mp4'])
    expect((await tar.read(entry!.bodyOffset, entry!.size)).toString()).toBe('gamma-gamma\n')
    expect(read).toHaveBeenCalledTimes(2)
  })

  it.each(['long-name-pax.tar', 'long-name-gnu.tar'])('%sの長い日本語名で本文を開ける', async fixtureName => {
    const archive = await loadFixture(fixtureName)
    const index = new TarRangeIndex(bufferReader(archive))
    const listing = await index.list({ entryLimit: 10 })
    const video = listing.entries.find(entry => entry.name.endsWith('.mp4'))!
    expect(video.name).toContain('日本語の動画/')
    expect(video.name.length).toBeGreaterThan(100)
    const entry = await index.find(video.name)
    expect(archive.subarray(entry!.bodyOffset, entry!.bodyOffset + entry!.size).toString()).toBe('long-name-video')
    expect(listing.entries).toHaveLength(2)
  })

  it('破損したヘッダーは空の一覧として扱わず失敗する', async () => {
    const corrupt = Buffer.from(tarBuf)
    corrupt[0] ^= 1
    await expect(new TarRangeIndex(bufferReader(corrupt)).list({ entryLimit: 10 }))
      .rejects.toThrow('checksum')
  })

  it('通信が失敗しても再試行で走査を再開できる', async () => {
    let fail = true
    const read: RangeReader = async (start, length) => {
      if (fail) { fail = false; throw new Error('connection lost') }
      return tarBuf.subarray(start, start + length)
    }
    const index = new TarRangeIndex(read)
    await expect(index.find('d/a.txt')).rejects.toThrow('connection lost')
    expect((await index.find('d/a.txt'))?.size).toBe(6)
  })
})
