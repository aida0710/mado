import { GetObjectCommand, NoSuchKey, S3Client } from '@aws-sdk/client-s3'
import { mockClient } from 'aws-sdk-client-mock'
import { Readable } from 'node:stream'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { mountS3PreviewRoutes } from './s3-preview.js'

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
