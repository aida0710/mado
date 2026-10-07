import { HeadObjectCommand, type S3Client } from '@aws-sdk/client-s3'
import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TarIndexCache } from './tar-index-cache.js'
import { RequestQueueFullError } from './shared-requests.js'

const bytes = readFileSync(new URL('./test-fixtures/sample.tar', import.meta.url))
const caches: TarIndexCache[] = []
afterEach(() => { caches.splice(0).forEach(cache => cache.close()); vi.restoreAllMocks() })

function fixture(etag: string | undefined = '"one"') {
  const state = { etag }
  const send = vi.fn(async (command: { input: { Range?: string; IfMatch?: string } }) => {
    if (command instanceof HeadObjectCommand) return { ETag: state.etag, ContentLength: bytes.length }
    const [, start, end] = command.input.Range!.match(/^bytes=(\d+)-(\d+)$/)!
    const body = bytes.subarray(Number(start), Number(end) + 1)
    expect(command.input.IfMatch).toBe(state.etag)
    return { Body: Readable.from(body), ContentRange: `bytes ${start}-${end}/${bytes.length}` }
  })
  const storage = { send } as unknown as S3Client
  const cache = new TarIndexCache()
  caches.push(cache)
  return { state, send, cache, open: (key = 'archive.tar') => cache.open({ storage, bucket: 'b', key }) }
}

describe('TarIndexCache', () => {
  it('同時のHEADと連続Rangeの確認を共有し、1秒後も索引は再利用する', async () => {
    const source = fixture()
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    const [first, second] = await Promise.all([source.open(), source.open()])
    expect(first.index).toBe(second.index)
    expect(source.send.mock.calls.filter(([command]) => command instanceof HeadObjectCommand)).toHaveLength(1)
    await first.index.find('d/a.txt')
    first.release(); second.release()
    const calls = source.send.mock.calls.length
    const warm = await source.open()
    expect(warm.index).toBe(first.index)
    warm.release()
    expect(source.send).toHaveBeenCalledTimes(calls)
    clock.mockReturnValue(now + 1001)
    const rechecked = await source.open()
    expect(rechecked.index).toBe(first.index)
    await rechecked.index.find('d/a.txt')
    expect(source.send).toHaveBeenCalledTimes(calls + 1)
    rechecked.release()
  })

  it('ETagの変更時は古い利用者を切らず、新しい索引へ切り替える', async () => {
    const source = fixture()
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    const first = await source.open()
    await first.index.find('d/a.txt')
    source.state.etag = '"two"'
    clock.mockReturnValue(now + 1001)
    const second = await source.open()
    expect(second.index).not.toBe(first.index)
    expect((await first.index.find('d/a.txt'))?.size).toBe(6)
    expect((await second.index.find('d/a.txt'))?.size).toBe(6)
    first.release(); second.release()
  })

  it('15分使われなかった索引を閉じ、再度開いたら作り直す', async () => {
    const source = fixture()
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    const first = await source.open()
    first.release()
    clock.mockReturnValue(now + 15 * 60_000 + 1)
    const next = await source.open()
    expect(next.index).not.toBe(first.index)
    next.release()
  })

  it('ETagのないstorageではHEADと索引を再確認する', async () => {
    const source = fixture()
    source.state.etag = undefined
    const first = await source.open()
    first.release()
    const second = await source.open()
    expect(second.index).not.toBe(first.index)
    expect(source.send).toHaveBeenCalledTimes(2)
    second.release()
  })

  it('使用中の索引は追い出さず、枠が空くまで新規の取得を断る', async () => {
    const source = fixture()
    const opened = []
    for (let i = 0; i < 32; i++) opened.push(await source.open(String(i)))
    await expect(source.open('overflow')).rejects.toThrow(RequestQueueFullError)
    opened[0].release()
    const next = await source.open('overflow')
    next.release()
    opened.forEach(archive => archive.release())
  })
})
