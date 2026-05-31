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

const storageMock = mockClient(S3Client)
const storage = new S3Client({})
const getStorage = async (): Promise<S3Client> => storage

const TEST_CONN_ID = 'testconn01'

// list_objects_version を切り替えられるよう mutable にしておく。
let listObjectsVersion: ListObjectsVersion = 'v2'
const getConnectionConfig = async (): Promise<ConnectionConfig> => ({
  listObjectsVersion,
})

const app = new Hono()
mountStorageListRoutes(app, { getStorage, getConnectionConfig })

interface ListResponse {
  directories: string[]
  files: { key: string; size: number; lastModified: string | null }[]
  nextContinuation: string | null
  nextStartAfter: string | null
}

beforeEach(() => {
  storageMock.reset()
  listObjectsVersion = 'v2'
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
