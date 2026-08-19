import {
  ListObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3'
import { mockClient } from 'aws-sdk-client-mock'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { mountStorageListRoutes } from './storage-list.js'
import type { ConnectionConfig, ListObjectsVersion } from '../storage.js'
import type { ResponseCache } from '../lib/storage-cache.js'

const storageMock = mockClient(S3Client)
const storage = new S3Client({})
const getStorage = async (): Promise<S3Client> => storage

const TEST_CONN_ID = 'testconn01'

// list_objects_version を切り替えられるよう mutable にしておく。
let listObjectsVersion: ListObjectsVersion = 'v2'
const getConnectionConfig = async (): Promise<ConnectionConfig> => ({
  listObjectsVersion,
  capabilities: {} as never,
  scanEnabled: true,
  listCacheTtlSec: 86400,
})

// 既定は素通し (常に miss、書き込みは捨てる) のキャッシュ。
// 個々のテストで差し替えられるよう、可変変数を経由して渡す。
function passthroughCache(): ResponseCache {
  return {
    get: async () => null,
    set: async () => {},
    invalidateScope: async () => {},
    invalidateConnection: async () => {},
  }
}

let cache: ResponseCache = passthroughCache()

const app = new Hono()
mountStorageListRoutes(app, {
  getStorage,
  getConnectionConfig,
  cache: {
    get: s => cache.get(s),
    set: (s, p) => cache.set(s, p),
    invalidateScope: (c, b, p) => cache.invalidateScope(c, b, p),
    invalidateConnection: c => cache.invalidateConnection(c),
  },
})

interface ListResponse {
  directories: string[]
  files: { key: string; size: number; lastModified: string | null }[]
  nextContinuation: string | null
  nextStartAfter: string | null
}

beforeEach(() => {
  storageMock.reset()
  listObjectsVersion = 'v2'
  cache = passthroughCache()
})

const FULL_KEY =
  'podcast-webdataset-v2_archive_2026_0505_022326_10_15_22_112-sidon-0000.tar.xz'

describe('GET /storage/:connId/list — exact-key prefix (検索ボックスでフルキー入力)', () => {
  it('v2: prefix がオブジェクトキーと完全一致するファイルを除外しない', async () => {
    // S3PathPanel でフルキーを貼ると prefix === Key の単一ヒットが返る。
    // これは「探しているファイルそのもの」なので files に残すべき。
    storageMock.on(ListObjectsV2Command).resolves({
      Contents: [{ Key: FULL_KEY, Size: 11041855340 }],
      CommonPrefixes: [],
      IsTruncated: false,
    })
    const res = await app.request(
      `/storage/${TEST_CONN_ID}/list?bucket=b&prefix=${encodeURIComponent(FULL_KEY)}`,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as ListResponse
    expect(body.files.map(f => f.key)).toEqual([FULL_KEY])
  })

  it('v1: prefix がオブジェクトキーと完全一致するファイルを除外しない', async () => {
    listObjectsVersion = 'v1'
    storageMock.on(ListObjectsCommand).resolves({
      Contents: [{ Key: FULL_KEY, Size: 11041855340 }],
      CommonPrefixes: [],
      IsTruncated: false,
    })
    const res = await app.request(
      `/storage/${TEST_CONN_ID}/list?bucket=b&prefix=${encodeURIComponent(FULL_KEY)}`,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as ListResponse
    expect(body.files.map(f => f.key)).toEqual([FULL_KEY])
  })
})

describe('GET /storage/:connId/list — directory prefix (末尾スラッシュ) は自分自身を隠す', () => {
  it('v2: prefix が "/" 終わりのとき、その placeholder オブジェクト (Key === prefix) は除外する', async () => {
    // foo/bar/ を開くと、互換実装によっては「ディレクトリ自身」を表す
    // 0 バイトの placeholder (Key === "foo/bar/") が返る。これは隠す。
    storageMock.on(ListObjectsV2Command).resolves({
      Contents: [
        { Key: 'foo/bar/', Size: 0 },
        { Key: 'foo/bar/a.txt', Size: 10 },
      ],
      CommonPrefixes: [],
      IsTruncated: false,
    })
    const res = await app.request(
      `/storage/${TEST_CONN_ID}/list?bucket=b&prefix=${encodeURIComponent('foo/bar/')}`,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as ListResponse
    expect(body.files.map(f => f.key)).toEqual(['foo/bar/a.txt'])
  })
})


describe('サーバー側キャッシュ', () => {
  it('hit したら S3 を呼ばずにキャッシュの中身を返す', async () => {
    const cached = { directories: ['cached/'], files: [], nextContinuation: null, nextStartAfter: null }
    cache = { ...passthroughCache(), get: async () => cached }

    const res = await app.request(`/storage/${TEST_CONN_ID}/list?bucket=b1`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(cached)
    expect(storageMock.calls()).toHaveLength(0)
  })

  it('miss なら S3 を呼び、その応答を set する', async () => {
    storageMock.on(ListObjectsV2Command).resolves({
      CommonPrefixes: [{ Prefix: 'b1/dir/' }], Contents: [], IsTruncated: false,
    })
    const sets: unknown[] = []
    cache = { ...passthroughCache(), set: async (_s, p) => { sets.push(p) } }

    const res = await app.request(`/storage/${TEST_CONN_ID}/list?bucket=b1`)
    expect(res.status).toBe(200)
    expect(storageMock.calls()).toHaveLength(1)
    expect(sets).toHaveLength(1)
    expect((sets[0] as { directories: string[] }).directories).toEqual(['b1/dir/'])
  })

  it('refresh=1 なら hit があっても無視して S3 を呼ぶ', async () => {
    storageMock.on(ListObjectsV2Command).resolves({
      CommonPrefixes: [{ Prefix: 'b1/fresh/' }], Contents: [], IsTruncated: false,
    })
    let getCalled = false
    cache = {
      ...passthroughCache(),
      get: async () => {
        getCalled = true
        return { directories: ['stale/'], files: [], nextContinuation: null, nextStartAfter: null }
      },
    }

    const res = await app.request(`/storage/${TEST_CONN_ID}/list?bucket=b1&refresh=1`)
    const body = await res.json() as { directories: string[] }
    expect(body.directories).toEqual(['b1/fresh/'])
    expect(getCalled).toBe(false)
    expect(storageMock.calls()).toHaveLength(1)
  })

  it('/buckets も同じくキャッシュを引く', async () => {
    const cached = { buckets: [{ name: 'from-cache', creationDate: null }] }
    cache = { ...passthroughCache(), get: async () => cached }

    const res = await app.request(`/storage/${TEST_CONN_ID}/buckets`)
    expect(await res.json()).toEqual(cached)
    expect(storageMock.calls()).toHaveLength(0)
  })
})
