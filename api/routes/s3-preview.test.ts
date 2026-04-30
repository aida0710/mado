import { GetObjectCommand, NoSuchKey, S3Client } from '@aws-sdk/client-s3'
import { mockClient } from 'aws-sdk-client-mock'
import { Readable } from 'node:stream'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { createReadStream } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mountS3PreviewRoutes } from './s3-preview.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (name: string) =>
  resolve(here, '../lib/test-fixtures', name)

const s3Mock = mockClient(S3Client)
const s3 = new S3Client({})
const app = new Hono()
mountS3PreviewRoutes(app, {
  s3,
  env: {
    PREVIEW_TEXT_LIMIT: 8,
    PREVIEW_TAR_ENTRY_LIMIT: 200,
    PREVIEW_TARXZ_BYTE_LIMIT: 1_000_000,
  },
})

beforeEach(() => s3Mock.reset())

describe('GET /api/s3/preview/text', () => {
  it('returns first PREVIEW_TEXT_LIMIT bytes with text/plain', async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: Readable.from(Buffer.from('hello world!! more content')) as never,
      ContentLength: 26,
    })
    const res = await app.request('/api/s3/preview/text?bucket=b&key=a.txt')
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text.length).toBeLessThanOrEqual(8)
    expect(text).toBe('hello wo')
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/)
  })

  it('400 if bucket or key missing', async () => {
    const res = await app.request('/api/s3/preview/text?key=a.txt')
    expect(res.status).toBe(400)
  })

  it('404 when S3 returns NoSuchKey', async () => {
    s3Mock.on(GetObjectCommand).rejects(
      new NoSuchKey({ message: 'no', $metadata: {} })
    )
    const res = await app.request('/api/s3/preview/text?bucket=b&key=missing.txt')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not found' })
  })
})

describe('GET /api/s3/preview/image', () => {
  it('proxies image bytes with content-type guessed from key', async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: Readable.from(Buffer.from([0xff, 0xd8, 0xff])) as never,
    })
    const res = await app.request(
      '/api/s3/preview/image?bucket=b&key=cat.jpg',
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
    s3Mock.on(GetObjectCommand).resolves({
      Body: Readable.from(Buffer.from([1, 2, 3])) as never,
    })
    const res = await app.request(
      `/api/s3/preview/image?bucket=b&key=${key}`,
    )
    expect(res.headers.get('content-type')).toBe(expected)
  })

  it('400 if bucket or key missing', async () => {
    const res = await app.request('/api/s3/preview/image?bucket=b')
    expect(res.status).toBe(400)
  })

  it('forwards Content-Length when known', async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: Readable.from(Buffer.from([1, 2, 3, 4, 5])) as never,
      ContentLength: 5,
    })
    const res = await app.request(
      '/api/s3/preview/image?bucket=b&key=a.png',
    )
    expect(res.headers.get('content-length')).toBe('5')
  })

  it('404 when S3 returns NoSuchKey', async () => {
    s3Mock.on(GetObjectCommand).rejects(
      new NoSuchKey({ message: 'no', $metadata: {} })
    )
    const res = await app.request('/api/s3/preview/image?bucket=b&key=missing.jpg')
    expect(res.status).toBe(404)
  })
})

describe('GET /api/s3/preview/audio', () => {
  it('forwards Range header to S3 and returns 206', async () => {
    s3Mock.on(GetObjectCommand, {
      Bucket: 'b', Key: 'a.mp3', Range: 'bytes=0-9',
    }).resolves({
      Body: Readable.from(Buffer.from('1234567890')) as never,
      ContentLength: 10,
      ContentRange: 'bytes 0-9/100',
    })
    const res = await app.request('/api/s3/preview/audio?bucket=b&key=a.mp3', {
      headers: { Range: 'bytes=0-9' },
    })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 0-9/100')
    expect(res.headers.get('content-length')).toBe('10')
    expect(res.headers.get('content-type')).toBe('audio/mpeg')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
  })

  it('returns 200 without Range', async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: Readable.from(Buffer.from('full')) as never,
      ContentLength: 4,
    })
    const res = await app.request('/api/s3/preview/audio?bucket=b&key=a.wav')
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
  ])('content-type for %s -> %s', async (key, expected) => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: Readable.from(Buffer.from([1])) as never,
    })
    const res = await app.request(
      `/api/s3/preview/audio?bucket=b&key=${key}`,
    )
    expect(res.headers.get('content-type')).toBe(expected)
  })

  it('400 if bucket or key missing', async () => {
    const res = await app.request('/api/s3/preview/audio?bucket=b')
    expect(res.status).toBe(400)
  })

  it('404 when S3 returns NoSuchKey', async () => {
    s3Mock.on(GetObjectCommand).rejects(
      new NoSuchKey({ message: 'no', $metadata: {} })
    )
    const res = await app.request('/api/s3/preview/audio?bucket=b&key=missing.mp3')
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

describe('GET /api/s3/preview/tar', () => {
  it('streams entries from a tar.gz as NDJSON ending with done', async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: createReadStream(fixture('sample.tar.gz')) as never,
    })
    const res = await app.request(
      '/api/s3/preview/tar?bucket=b&key=foo/sample.tar.gz',
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
    s3Mock.on(GetObjectCommand).resolves({
      Body: createReadStream(fixture('sample.tar')) as never,
    })
    const res = await app.request(
      '/api/s3/preview/tar?bucket=b&key=foo/sample.tar',
    )
    expect(res.status).toBe(200)
    const names = entriesOf(await readNdjson(res)).map(e => e.name)
    expect(names).toEqual(expect.arrayContaining([
      'd/a.txt', 'd/b.txt', 'd/c.txt',
    ]))
  })

  it('streams entries from a tar.xz', async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: createReadStream(fixture('sample.tar.xz')) as never,
    })
    const res = await app.request(
      '/api/s3/preview/tar?bucket=b&key=foo/sample.tar.xz',
    )
    expect(res.status).toBe(200)
    const names = entriesOf(await readNdjson(res)).map(e => e.name).sort()
    expect(names).toEqual(['d/', 'd/a.txt', 'd/b.txt', 'd/c.txt'])
  })

  it('respects ?limit=2 and reports hasMore:true in the done line', async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: createReadStream(fixture('sample.tar.gz')) as never,
    })
    const res = await app.request(
      '/api/s3/preview/tar?bucket=b&key=foo/sample.tar.gz&limit=2',
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
    s3Mock.on(GetObjectCommand).resolves({
      Body: createReadStream(fixture('sample.tar.gz')) as never,
    })
    const r1 = await app.request(
      '/api/s3/preview/tar?bucket=b&key=s.tar.gz&limit=2&offset=0',
    )
    const lines1 = await readNdjson(r1)
    const e1 = entriesOf(lines1)
    expect(e1).toHaveLength(2)
    expect(doneOf(lines1)?.hasMore).toBe(true)

    s3Mock.reset()
    s3Mock.on(GetObjectCommand).resolves({
      Body: createReadStream(fixture('sample.tar.gz')) as never,
    })
    const r2 = await app.request(
      '/api/s3/preview/tar?bucket=b&key=s.tar.gz&limit=2&offset=2',
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
      '/api/s3/preview/tar?bucket=b&key=foo.zip',
    )
    expect(res.status).toBe(400)
  })

  it('detects .tgz as gz', async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: createReadStream(fixture('sample.tar.gz')) as never,
    })
    const res = await app.request(
      '/api/s3/preview/tar?bucket=b&key=foo/sample.tgz',
    )
    expect(res.status).toBe(200)
  })

  it('400 if bucket or key missing', async () => {
    const res = await app.request('/api/s3/preview/tar?bucket=b')
    expect(res.status).toBe(400)
  })

  it('emits {error} line when S3 returns NoSuchKey (status 200, error in body)', async () => {
    s3Mock.on(GetObjectCommand).rejects(
      new NoSuchKey({ message: 'no', $metadata: {} })
    )
    const res = await app.request(
      '/api/s3/preview/tar?bucket=b&key=foo.tar.gz',
    )
    // The stream has already opened a 200 response by the time we discover
    // the missing key, so the error surfaces as an NDJSON `{error: ...}`
    // line rather than an HTTP status. Front-end treats it as a thrown
    // error during stream consumption.
    expect(res.status).toBe(200)
    const lines = await readNdjson(res)
    const errLine = lines.find((l): l is { error: string } => 'error' in l)
    expect(errLine?.error).toMatch(/not found|NoSuchKey|no/i)
  })
})
