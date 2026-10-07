import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { mockClient } from 'aws-sdk-client-mock'
import { Readable } from 'node:stream'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { createVirtualTar, type VirtualTar } from '../lib/test-fixtures/virtual-tar.js'
import { mountStoragePreviewRoutes } from './storage-preview.js'

const storageMock = mockClient(S3Client)
const storage = new S3Client({})
let app: Hono
const url = '/storage/c/preview/tar-entry?bucket=b&key=large.tar&entry=large.mp4'

beforeEach(() => {
  storageMock.reset()
  app = new Hono()
  mountStoragePreviewRoutes(app, {
    getStorage: async () => storage,
    env: { PREVIEW_TEXT_LIMIT: 64, PREVIEW_TAR_ENTRY_LIMIT: 10, PREVIEW_TARXZ_BYTE_LIMIT: 1024, PREVIEW_TAR_ENTRY_MAX_BYTES: 100 * 1024 * 1024 },
  })
})

// 大容量本文は64KiBずつ生成し、全量バッファする実装になった場合は検知できる。
const BODY_CHUNK_BYTES = 64 * 1024
function serveVirtualTar(tar: VirtualTar, etag = 'v1'): void {
  storageMock.on(HeadObjectCommand).resolves({ ContentLength: tar.size, ETag: etag })
  storageMock.on(GetObjectCommand).callsFake(input => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(input.Range ?? '')
    if (!match) throw new Error('tar body requested without a range')
    const start = Number(match[1])
    const end = Number(match[2])
    if (input.IfMatch !== etag) throw new Error('tar request is missing its object identity')
    const chunks = async function* () {
      for (let position = start; position <= end; position += BODY_CHUNK_BYTES) {
        yield await tar.read(position, Math.min(BODY_CHUNK_BYTES, end - position + 1))
      }
    }
    return {
      Body: Readable.from(chunks()), ContentLength: end - start + 1,
      ContentRange: `bytes ${start}-${end}/${tar.size}`,
    }
  })
}

describe('大容量tar内動画の配信', () => {
  it.each([1, 10] as const)('%iGiBの動画でも指定区間だけ返し、tar本体を順次読まない', async gigabytes => {
    const tar = createVirtualTar(gigabytes)
    serveVirtualTar(tar)
    const res = await app.request(url, { headers: { Range: 'bytes=100-199' } })
    expect(res.status).toBe(206)
    expect(res.headers.get('Content-Range')).toBe(`bytes 100-199/${tar.videoSize}`)
    expect(res.headers.get('Content-Length')).toBe('100')
    expect(res.headers.get('Content-Type')).toBe('video/mp4')
    expect(res.headers.get('Accept-Ranges')).toBe('bytes')
    expect((await res.arrayBuffer()).byteLength).toBe(100)
    expect(storageMock.commandCalls(GetObjectCommand).map(call => call.args[0].input.Range))
      .toEqual(['bytes=0-262143', 'bytes=612-711'])
  })

  it('MP4の末尾を取得でき、シークを繰り返してもヘッダーを読み直さない', async () => {
    const tar = createVirtualTar()
    serveVirtualTar(tar)
    const first = await app.request(url, { headers: { Range: 'bytes=0-9' } })
    await first.arrayBuffer()
    const last = await app.request(url, { headers: { Range: 'bytes=-9' } })
    expect(await last.text()).toBe('VIDEO-END')
    expect(last.headers.get('Content-Range')).toBe(`bytes ${tar.videoSize - 9}-${tar.videoSize - 1}/${tar.videoSize}`)
    expect(storageMock.commandCalls(GetObjectCommand)).toHaveLength(3)
    expect(storageMock.commandCalls(HeadObjectCommand)).toHaveLength(2)
  })

  it('一覧で取得した位置を再生に使い、次のページも本文を読み飛ばす', async () => {
    const tar = createVirtualTar()
    serveVirtualTar(tar)
    const listUrl = '/storage/c/preview/tar?bucket=b&key=large.tar&limit=1'
    const listing = await app.request(listUrl)
    const firstPage = await listing.text()
    expect(firstPage).toContain('large.mp4')
    expect(firstPage).toContain('"hasMore":true')
    const readsAfterListing = storageMock.commandCalls(GetObjectCommand).length
    const video = await app.request(url, { headers: { Range: 'bytes=0-9' } })
    await video.arrayBuffer()
    expect(storageMock.commandCalls(GetObjectCommand)).toHaveLength(readsAfterListing + 1)
    const secondPage = await app.request(`${listUrl}&offset=1`)
    expect(await secondPage.text()).toContain('d/')
    expect(storageMock.commandCalls(GetObjectCommand)).toHaveLength(readsAfterListing + 1)
  })

  it('Rangeが無くても全量をバッファせず本文ストリームを返す', async () => {
    const tar = createVirtualTar()
    serveVirtualTar(tar)
    const res = await app.request(url)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Length')).toBe(String(tar.videoSize))
    expect(res.headers.get('Content-Range')).toBeNull()
    const reader = res.body!.getReader()
    const first = await reader.read()
    expect(first.value?.length).toBeLessThanOrEqual(BODY_CHUNK_BYTES)
    await reader.cancel()
    const body = storageMock.commandCalls(GetObjectCommand).at(-1)!.returnValue
    expect((await body).Body.destroyed).toBe(true)
  })

  it('HEADは動画本文を取得せずサイズと再生情報を返す', async () => {
    const tar = createVirtualTar()
    serveVirtualTar(tar)
    const res = await app.request(url, { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Length')).toBe(String(tar.videoSize))
    expect(await res.text()).toBe('')
    expect(storageMock.commandCalls(GetObjectCommand)).toHaveLength(1)
  })

  it('HEADではRangeを無視してファイル全体のサイズを返す', async () => {
    const tar = createVirtualTar()
    serveVirtualTar(tar)
    const res = await app.request(url, { method: 'HEAD', headers: { Range: 'bytes=0-9' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Length')).toBe(String(tar.videoSize))
    expect(res.headers.get('Content-Range')).toBeNull()
    expect(storageMock.commandCalls(GetObjectCommand)).toHaveLength(1)
  })

  it('ブラウザが本文を読んでいない間は先読みを小さく保つ', async () => {
    const tar = createVirtualTar()
    let generatedBytes = 0
    serveVirtualTar({ ...tar, read: async (start, length) => {
      generatedBytes += length
      return tar.read(start, length)
    } })
    const res = await app.request(url)
    // I/Oが進む機会を与えてから、ヘッダーと数チャンク以内で止まることを確認する。
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(generatedBytes).toBeLessThanOrEqual(256 * 1024 + BODY_CHUNK_BYTES * 3)
    await res.body!.cancel()
  })

  it.each(['bytes=1073741824-', 'bytes=10-2', 'bytes=0-1,10-11'])('不正なRange %s は本文を取得せず416を返す', async range => {
    const tar = createVirtualTar()
    serveVirtualTar(tar)
    const res = await app.request(url, { headers: { Range: range } })
    expect(res.status).toBe(416)
    expect(res.headers.get('Content-Range')).toBe(`bytes */${tar.videoSize}`)
    expect(storageMock.commandCalls(GetObjectCommand)).toHaveLength(1)
  })

  it('オブジェクトが差し替わったら古い位置・サイズを使わない', async () => {
    serveVirtualTar(createVirtualTar(), 'v1')
    const first = await app.request(url, { headers: { Range: 'bytes=0-9' } })
    await first.arrayBuffer()
    const replacement = createVirtualTar(10)
    serveVirtualTar(replacement, 'v2')
    const second = await app.request(url, { headers: { Range: 'bytes=0-9' } })
    await second.arrayBuffer()
    expect(second.headers.get('Content-Range')).toBe(`bytes 0-9/${replacement.videoSize}`)
    expect(storageMock.commandCalls(GetObjectCommand).filter(call => call.args[0].input.Range === 'bytes=0-262143')).toHaveLength(2)
  })

  it('ヘッダー取得に失敗したら、不完全な一覧を成功として返さない', async () => {
    serveVirtualTar(createVirtualTar())
    storageMock.on(GetObjectCommand).rejects(new Error('network failed'))
    const res = await app.request('/storage/c/preview/tar?bucket=b&key=large.tar')
    const listing = await res.text()
    expect(listing).toContain('"error"')
    expect(listing).not.toContain('"done"')
  })

  it('S3がRangeを無視したら大容量本文をバッファせず取得を止める', async () => {
    const tar = createVirtualTar()
    serveVirtualTar(tar)
    const body = new Readable({ read() {} })
    storageMock.on(GetObjectCommand).resolves({ Body: body as never, ContentLength: tar.size })
    const res = await app.request(url, { headers: { Range: 'bytes=0-9' } })
    expect(res.status).toBe(500)
    expect(body.destroyed).toBe(true)
  })

  it('HEADの直後にtarが変わったら古い位置で本文を返さない', async () => {
    const tar = createVirtualTar()
    serveVirtualTar(tar)
    const first = await app.request(url, { headers: { Range: 'bytes=0-9' } })
    await first.arrayBuffer()
    storageMock.on(GetObjectCommand).rejects({ name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } })
    const second = await app.request(url, { headers: { Range: 'bytes=10-19' } })
    expect(second.status).toBe(412)
    expect(await second.json()).toEqual({ error: 'object changed; retry the request' })
  })
})
