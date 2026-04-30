import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { mockClient } from 'aws-sdk-client-mock'
import { Readable } from 'node:stream'
import { Hono } from 'hono'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPools, closePools } from '../db.js'
import { mountS3ReadmeRoutes } from './s3-readme.js'

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const RO = RW.replace('dashboard_rw', 'dashboard_ro')
const pools = createPools({ rw: RW, ro: RO })
const s3Mock = mockClient(S3Client)
const s3 = new S3Client({})

const app = new Hono()
mountS3ReadmeRoutes(app, { s3, pools })

beforeEach(async () => {
  s3Mock.reset()
  await pools.rw.query('TRUNCATE s3_readme_meta')
})
afterAll(() => closePools(pools))

describe('GET /api/s3/readme', () => {
  it('returns body and meta when README exists', async () => {
    s3Mock.on(GetObjectCommand, { Bucket: 'b', Key: 'voice/jp/README.md' })
      .resolves({
        Body: Readable.from(Buffer.from('# Voice JP\nhello')) as never,
      })
    await pools.rw.query(
      `INSERT INTO s3_readme_meta(bucket, prefix, last_editor, size_bytes)
       VALUES('b','voice/jp/','tanaka',16)`
    )
    const res = await app.request('/api/s3/readme?bucket=b&prefix=voice/jp/')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      exists: true; body: string; last_editor: string | null
    }
    expect(body.exists).toBe(true)
    expect(body.body).toBe('# Voice JP\nhello')
    expect(body.last_editor).toBe('tanaka')
  })

  it('returns exists:false when README is absent', async () => {
    s3Mock.on(GetObjectCommand).rejects(
      Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' })
    )
    const res = await app.request('/api/s3/readme?bucket=b&prefix=missing/')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ exists: false })
  })

  it('handles bucket root (empty prefix)', async () => {
    s3Mock.on(GetObjectCommand, { Bucket: 'b', Key: 'README.md' })
      .resolves({
        Body: Readable.from(Buffer.from('root')) as never,
      })
    const res = await app.request('/api/s3/readme?bucket=b&prefix=')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { exists: true; body: string }
    expect(body.body).toBe('root')
  })

  it('400 when bucket missing', async () => {
    const res = await app.request('/api/s3/readme')
    expect(res.status).toBe(400)
  })
})

describe('PUT /api/s3/readme', () => {
  it('uploads body and upserts meta', async () => {
    s3Mock.on(PutObjectCommand).resolves({})
    const res = await app.request('/api/s3/readme', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bucket: 'b', prefix: 'voice/jp/', body: 'new body', editor: 'sato',
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: true; size_bytes: number }
    expect(body.ok).toBe(true)
    expect(body.size_bytes).toBe(Buffer.byteLength('new body', 'utf-8'))

    // S3 PUT was called with the right key + content-type
    const calls = s3Mock.commandCalls(PutObjectCommand)
    expect(calls).toHaveLength(1)
    expect(calls[0].args[0].input).toMatchObject({
      Bucket: 'b',
      Key: 'voice/jp/README.md',
      ContentType: 'text/markdown',
    })

    // DB row was inserted
    const r = await pools.rw.query(
      'SELECT bucket, prefix, last_editor, size_bytes FROM s3_readme_meta'
    )
    expect(r.rows).toEqual([
      { bucket: 'b', prefix: 'voice/jp/', last_editor: 'sato', size_bytes: 8 },
    ])
  })

  it('upserts (overwrites) the existing meta row', async () => {
    s3Mock.on(PutObjectCommand).resolves({})
    await pools.rw.query(
      `INSERT INTO s3_readme_meta(bucket, prefix, last_editor, size_bytes)
       VALUES('b','voice/jp/','tanaka',5)`
    )
    const res = await app.request('/api/s3/readme', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bucket: 'b', prefix: 'voice/jp/', body: 'newer', editor: 'sato',
      }),
    })
    expect(res.status).toBe(200)
    const r = await pools.rw.query(
      'SELECT last_editor, size_bytes FROM s3_readme_meta'
    )
    expect(r.rows).toEqual([{ last_editor: 'sato', size_bytes: 5 }])
  })

  it('does NOT touch DB when S3 PUT fails (atomicity)', async () => {
    s3Mock.on(PutObjectCommand).rejects(new Error('s3 down'))
    const res = await app.request('/api/s3/readme', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bucket: 'b', prefix: 'voice/jp/', body: 'new', editor: 'sato',
      }),
    })
    expect(res.status).toBe(500)
    const r = await pools.rw.query('SELECT count(*) FROM s3_readme_meta')
    expect(r.rows[0].count).toBe('0')
  })

  it('400 on malformed JSON body', async () => {
    const res = await app.request('/api/s3/readme', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bucket: 'b' }), // missing prefix, body, editor
    })
    expect(res.status).toBe(400)
  })
})
