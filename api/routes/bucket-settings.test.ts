import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { mountBucketSettingsRoutes } from './bucket-settings.js'
import { DEFAULT_BUCKET_SETTINGS } from '../lib/bucket-settings.js'

let stored: Array<[string, string, string, string]> = []
let current = { ...DEFAULT_BUCKET_SETTINGS }

const app = new Hono()
mountBucketSettingsRoutes(app, {
  bucketSettings: {
    get: async () => current,
    set: async (c: string, b: string, k: string, v: string) => { stored.push([c, b, k, v]) },
  },
})

const put = (body: unknown): Promise<Response> =>
  app.request('/storage/c1/bucket-settings?bucket=b1', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

beforeEach(() => { stored = []; current = { ...DEFAULT_BUCKET_SETTINGS } })

describe('bucket-settings ルート', () => {
  it('GET は現在の設定を返す', async () => {
    const res = await app.request('/storage/c1/bucket-settings?bucket=b1')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ scanEnabled: true, listCacheTtlSec: 86400 })
  })

  it('GET は bucket 必須', async () => {
    expect((await app.request('/storage/c1/bucket-settings')).status).toBe(400)
  })

  it('PUT で設定を書ける', async () => {
    const res = await put({ key: 'scan_enabled', value: 'false' })
    expect(res.status).toBe(200)
    expect(stored).toEqual([['c1', 'b1', 'scan_enabled', 'false']])
  })

  // 任意のキーを書けると設定テーブルが野放しになる。
  it('未知の key は 400 で弾く', async () => {
    expect((await put({ key: 'arbitrary_key', value: 'x' })).status).toBe(400)
    expect(stored).toHaveLength(0)
  })

  it('list_cache_ttl_sec に数値以外を書こうとしたら 400', async () => {
    expect((await put({ key: 'list_cache_ttl_sec', value: 'いいかんじ' })).status).toBe(400)
  })

  it('scan_enabled に true/false 以外を書こうとしたら 400', async () => {
    expect((await put({ key: 'scan_enabled', value: 'maybe' })).status).toBe(400)
  })
})
