import { GetObjectCommand, NoSuchKey, S3Client } from '@aws-sdk/client-s3'
import { mockClient } from 'aws-sdk-client-mock'
import { Readable } from 'node:stream'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { createReadStream } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mountStoragePreviewRoutes } from './storage-preview.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (name: string) =>
  resolve(here, '../lib/test-fixtures', name)

const storageMock = mockClient(S3Client)
const storage = new S3Client({})
const getStorage = async (): Promise<S3Client> => storage
const TEST_CONN_ID = 'testconn01'
const app = new Hono()
mountStoragePreviewRoutes(app, {
  getStorage,
  env: {
    PREVIEW_TEXT_LIMIT: 8,
    PREVIEW_TAR_ENTRY_LIMIT: 200,
    PREVIEW_TARXZ_BYTE_LIMIT: 1_000_000,
  },
})

beforeEach(() => storageMock.reset())

describe('GET /storage/:connId/preview/text', () => {
  it('returns first PREVIEW_TEXT_LIMIT bytes with text/plain', async () => {
    storageMock.on(GetObjectCommand).resolves({
      Body: Readable.from(Buffer.from('hello world!! more content')) as never,
      ContentLength: 26,
    })
    const res = await app.request(`/storage/${TEST_CONN_ID}/preview/text?bucket=b&key=a.txt`)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text.length).toBeLessThanOrEqual(8)
    expect(text).toBe('hello wo')
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/)
  })

  it('400 if bucket or key missing', async () => {
    const res = await app.request(`/storage/${TEST_CONN_ID}/preview/text?key=a.txt`)
    expect(res.status).toBe(400)
  })

  it('404 when storage returns NoSuchKey', async () => {
    storageMock.on(GetObjectCommand).rejects(
      new NoSuchKey({ message: 'no', $metadata: {} })
    )
    const res = await app.request(`/storage/${TEST_CONN_ID}/preview/text?bucket=b&key=missing.txt`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not found' })
  })
})

describe('GET /storage/:connId/preview/raw', () => {
  it('streams bytes as application/octet-stream with attachment Content-Disposition', async () => {
    storageMock.on(GetObjectCommand).resolves({
      Body: Readable.from(Buffer.from('binary-bytes')) as never,
      ContentLength: 12,
    })
    const res = await app.request(
      `/storage/${TEST_CONN_ID}/preview/raw?bucket=b&key=path/to/file.bin`,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(res.headers.get('content-length')).toBe('12')
    const cd = res.headers.get('content-disposition') ?? ''
    expect(cd).toContain('attachment')
    expect(cd).toContain('filename="file.bin"')
    expect(cd).toContain("filename*=UTF-8''file.bin")
    expect(await res.text()).toBe('binary-bytes')
  })

  it('日本語ファイル名を RFC5987 で encode する', async () => {
    storageMock.on(GetObjectCommand).resolves({
      Body: Readable.from(Buffer.from('x')) as never,
      ContentLength: 1,
    })
    const res = await app.request(
      `/storage/${TEST_CONN_ID}/preview/raw?bucket=b&key=${encodeURIComponent('音声/サンプル.wav')}`,
    )
    expect(res.status).toBe(200)
    const cd = res.headers.get('content-disposition') ?? ''
    // ASCII fallback は非 ASCII を _ に
    expect(cd).toMatch(/filename="[_.\w]+"/)
    // UTF-8 真値で日本語 (% encode) を含む
    expect(cd).toContain(encodeURIComponent('サンプル.wav'))
  })

  it('400 if bucket or key missing', async () => {
    const res = await app.request(`/storage/${TEST_CONN_ID}/preview/raw?key=a`)
    expect(res.status).toBe(400)
  })

  it('404 when storage returns NoSuchKey', async () => {
    storageMock.on(GetObjectCommand).rejects(
      new NoSuchKey({ message: 'no', $metadata: {} }),
    )
    const res = await app.request(`/storage/${TEST_CONN_ID}/preview/raw?bucket=b&key=x`)
    expect(res.status).toBe(404)
  })
})

describe('GET /storage/:connId/preview/image', () => {
  it('proxies image bytes with content-type guessed from key', async () => {
    storageMock.on(GetObjectCommand).resolves({
      Body: Readable.from(Buffer.from([0xff, 0xd8, 0xff])) as never,
    })
    const res = await app.request(
      `/storage/${TEST_CONN_ID}/preview/image?bucket=b&key=cat.jpg`,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    const buf = Buffer.from(await res.arrayBuffer())
    expect(buf).toEqual(Buffer.from([0xff, 0xd8, 0xff]))
  })

  it.each([
    ['cat.png',  'image/png'],
    ['cat.webp', 'image/webp'],
    ['cat.gif',  'image/gif'],
    ['cat.jpeg', 'image/jpeg'],
  ])('content-type for %s -> %s', async (key, expected) => {
    storageMock.on(GetObjectCommand).resolves({
      Body: Readable.from(Buffer.from([1, 2, 3])) as never,
    })
    const res = await app.request(
      `/storage/${TEST_CONN_ID}/preview/image?bucket=b&key=${key}`,
    )
    expect(res.headers.get('content-type')).toBe(expected)
  })

  it('400 if bucket or key missing', async () => {
    const res = await app.request(`/storage/${TEST_CONN_ID}/preview/image?bucket=b`)
    expect(res.status).toBe(400)
  })

  it('forwards Content-Length when known', async () => {
    storageMock.on(GetObjectCommand).resolves({
      Body: Readable.from(Buffer.from([1, 2, 3, 4, 5])) as never,
      ContentLength: 5,
    })
    const res = await app.request(
      `/storage/${TEST_CONN_ID}/preview/image?bucket=b&key=a.png`,
    )
    expect(res.headers.get('content-length')).toBe('5')
  })

  it('404 when storage returns NoSuchKey', async () => {
    storageMock.on(GetObjectCommand).rejects(
      new NoSuchKey({ message: 'no', $metadata: {} })
    )
    const res = await app.request(`/storage/${TEST_CONN_ID}/preview/image?bucket=b&key=missing.jpg`)
    expect(res.status).toBe(404)
  })
})

describe('GET /storage/:connId/preview/audio', () => {
  it('forwards Range header to storage and returns 206', async () => {
    storageMock.on(GetObjectCommand, {
      Bucket: 'b', Key: 'a.mp3', Range: 'bytes=0-9',
    }).resolves({
      Body: Readable.from(Buffer.from('1234567890')) as never,
      ContentLength: 10,
      ContentRange: 'bytes 0-9/100',
    })
    const res = await app.request(`/storage/${TEST_CONN_ID}/preview/audio?bucket=b&key=a.mp3`, {
      headers: { Range: 'bytes=0-9' },
    })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 0-9/100')
    expect(res.headers.get('content-length')).toBe('10')
    expect(res.headers.get('content-type')).toBe('audio/mpeg')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
  })

  it('returns 200 without Range', async () => {
    storageMock.on(GetObjectCommand).resolves({
      Body: Readable.from(Buffer.from('full')) as never,
      ContentLength: 4,
    })
    const res = await app.request(`/storage/${TEST_CONN_ID}/preview/audio?bucket=b&key=a.wav`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/wav')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('content-range')).toBeNull()
  })

  it.each([
    ['a.mp3',  'audio/mpeg'],
    ['a.wav',  'audio/wav'],
    ['a.flac', 'audio/flac'],
    ['a.ogg',  'audio/ogg'],
    ['a.oga',  'audio/ogg'],
    ['a.opus', 'audio/ogg'],
    ['a.m4a',  'audio/mp4'],
    ['a.m4b',  'audio/mp4'],
    ['a.aac',  'audio/aac'],
    ['a.weba', 'audio/webm'],
    ['a.aiff', 'audio/aiff'],
    ['a.aif',  'audio/aiff'],
    ['a.wma',  'audio/x-ms-wma'],
  ])('content-type for %s -> %s', async (key, expected) => {
    storageMock.on(GetObjectCommand).resolves({
      Body: Readable.from(Buffer.from([1])) as never,
    })
    const res = await app.request(
      `/storage/${TEST_CONN_ID}/preview/audio?bucket=b&key=${key}`,
    )
    expect(res.headers.get('content-type')).toBe(expected)
  })

  it('400 if bucket or key missing', async () => {
    const res = await app.request(`/storage/${TEST_CONN_ID}/preview/audio?bucket=b`)
    expect(res.status).toBe(400)
  })

  it('404 when storage returns NoSuchKey', async () => {
    storageMock.on(GetObjectCommand).rejects(
      new NoSuchKey({ message: 'no', $metadata: {} })
    )
    const res = await app.request(`/storage/${TEST_CONN_ID}/preview/audio?bucket=b&key=missing.mp3`)
    expect(res.status).toBe(404)
  })
})

interface NdjsonEntryLine { entry: { name: string; size: number; type: string } }
interface NdjsonDoneLine {
  done: { truncated: boolean; hasMore: boolean; offset: number; limit: number }
}
interface NdjsonErrorLine { error: string }
type NdjsonLine = NdjsonEntryLine | NdjsonDoneLine | NdjsonErrorLine

async function readNdjson(res: Response): Promise<NdjsonLine[]> {
  const text = await res.text()
  return text
    .split('\n')
    .filter(l => l.length > 0)
    .map(l => JSON.parse(l) as NdjsonLine)
}

function entriesOf(lines: NdjsonLine[]): { name: string; size: number; type: string }[] {
  return lines.flatMap(l => ('entry' in l ? [l.entry] : []))
}

function doneOf(lines: NdjsonLine[]): NdjsonDoneLine['done'] | undefined {
  return lines.find((l): l is NdjsonDoneLine => 'done' in l)?.done
}

describe('GET /storage/:connId/preview/tar', () => {
  it('streams entries from a tar.gz as NDJSON ending with done', async () => {
    storageMock.on(GetObjectCommand).resolves({
      Body: createReadStream(fixture('sample.tar.gz')) as never,
    })
    const res = await app.request(
      `/storage/${TEST_CONN_ID}/preview/tar?bucket=b&key=foo/sample.tar.gz`,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/x-ndjson/)
    const lines = await readNdjson(res)
    const done = doneOf(lines)
    expect(done?.truncated).toBe(false)
    expect(entriesOf(lines).map(e => e.name)).toEqual(
      expect.arrayContaining(['d/a.txt', 'd/b.txt', 'd/c.txt']),
    )
  })

  it('streams entries from a plain tar', async () => {
    storageMock.on(GetObjectCommand).resolves({
      Body: createReadStream(fixture('sample.tar')) as never,
    })
    const res = await app.request(
      `/storage/${TEST_CONN_ID}/preview/tar?bucket=b&key=foo/sample.tar`,
    )
    expect(res.status).toBe(200)
    const names = entriesOf(await readNdjson(res)).map(e => e.name)
    expect(names).toEqual(expect.arrayContaining([
      'd/a.txt', 'd/b.txt', 'd/c.txt',
    ]))
  })

  it('streams entries from a tar.xz', async () => {
    storageMock.on(GetObjectCommand).resolves({
      Body: createReadStream(fixture('sample.tar.xz')) as never,
    })
    const res = await app.request(
      `/storage/${TEST_CONN_ID}/preview/tar?bucket=b&key=foo/sample.tar.xz`,
    )
    expect(res.status).toBe(200)
    const names = entriesOf(await readNdjson(res)).map(e => e.name).sort()
    expect(names).toEqual(['d/', 'd/a.txt', 'd/b.txt', 'd/c.txt'])
  })

  it('respects ?limit=2 and reports hasMore:true in the done line', async () => {
    storageMock.on(GetObjectCommand).resolves({
      Body: createReadStream(fixture('sample.tar.gz')) as never,
    })
    const res = await app.request(
      `/storage/${TEST_CONN_ID}/preview/tar?bucket=b&key=foo/sample.tar.gz&limit=2`,
    )
    expect(res.status).toBe(200)
    const lines = await readNdjson(res)
    expect(entriesOf(lines)).toHaveLength(2)
    const done = doneOf(lines)
    expect(done?.hasMore).toBe(true)
    expect(done?.truncated).toBe(false)
    expect(done?.offset).toBe(0)
    expect(done?.limit).toBe(2)
  })

  it('paginates with ?offset', async () => {
    storageMock.on(GetObjectCommand).resolves({
      Body: createReadStream(fixture('sample.tar.gz')) as never,
    })
    const r1 = await app.request(
      `/storage/${TEST_CONN_ID}/preview/tar?bucket=b&key=s.tar.gz&limit=2&offset=0`,
    )
    const lines1 = await readNdjson(r1)
    const e1 = entriesOf(lines1)
    expect(e1).toHaveLength(2)
    expect(doneOf(lines1)?.hasMore).toBe(true)

    storageMock.reset()
    storageMock.on(GetObjectCommand).resolves({
      Body: createReadStream(fixture('sample.tar.gz')) as never,
    })
    const r2 = await app.request(
      `/storage/${TEST_CONN_ID}/preview/tar?bucket=b&key=s.tar.gz&limit=2&offset=2`,
    )
    const lines2 = await readNdjson(r2)
    const e2 = entriesOf(lines2)
    expect(e2).toHaveLength(2)
    expect(doneOf(lines2)?.hasMore).toBe(false)
    expect(doneOf(lines2)?.offset).toBe(2)

    expect([...e1, ...e2].map(e => e.name).sort())
      .toEqual(['d/', 'd/a.txt', 'd/b.txt', 'd/c.txt'])
  })

  it('400 for unsupported extension (.zip)', async () => {
    const res = await app.request(
      `/storage/${TEST_CONN_ID}/preview/tar?bucket=b&key=foo.zip`,
    )
    expect(res.status).toBe(400)
  })

  it('detects .tgz as gz', async () => {
    storageMock.on(GetObjectCommand).resolves({
      Body: createReadStream(fixture('sample.tar.gz')) as never,
    })
    const res = await app.request(
      `/storage/${TEST_CONN_ID}/preview/tar?bucket=b&key=foo/sample.tgz`,
    )
    expect(res.status).toBe(200)
  })

  it('400 if bucket or key missing', async () => {
    const res = await app.request(`/storage/${TEST_CONN_ID}/preview/tar?bucket=b`)
    expect(res.status).toBe(400)
  })

  it('emits {error} line when storage returns NoSuchKey (status 200, error in body)', async () => {
    storageMock.on(GetObjectCommand).rejects(
      new NoSuchKey({ message: 'no', $metadata: {} })
    )
    const res = await app.request(
      `/storage/${TEST_CONN_ID}/preview/tar?bucket=b&key=foo.tar.gz`,
    )
    // キーが見つからないと判明した時点でストリームはすでに 200 レスポンスを開いているため、
    // エラーは HTTP ステータスではなく NDJSON の `{error: ...}` 行として
    // 表面化する。フロントエンドはストリーム消費中のスロー済みエラーとして扱う。
    expect(res.status).toBe(200)
    const lines = await readNdjson(res)
    const errLine = lines.find((l): l is { error: string } => 'error' in l)
    expect(errLine?.error).toMatch(/not found|NoSuchKey|no/i)
  })
})
