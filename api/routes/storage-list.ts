import {
  ListBucketsCommand,
  ListObjectsCommand,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
} from '@aws-sdk/client-s3'
import type { Hono } from 'hono'
import { resolveStorageOrFail, type GetStorage } from './_storageRequest.js'
import type { ConnectionConfig } from '../storage.js'
import type { CacheScope, ResponseCache } from '../lib/storage-cache.js'

export interface StorageListDeps {
  getStorage: GetStorage
  /** 接続ごとの API 設定 (list_objects_version 等) を返す。
   *  V1 only の S3 互換サーバ には v1、
   *  それ以外 (AWS/R2/MinIO) は v2 を使う。 */
  getConnectionConfig: (connectionId: string) => Promise<ConnectionConfig>
  /** /list と /buckets の応答キャッシュ。失敗は内部で握りつぶされるので
   *  呼び出し側は try/catch を書かない。 */
  cache: ResponseCache
}

interface ListBody {
  directories: string[]
  files: Array<{ key: string; size: number; lastModified: string | null }>
  nextContinuation: string | null
  nextStartAfter: string | null
}

function withCacheMeta(
  body: ListBody,
  meta: { fetchedAt: string; expiresAt: string },
  hit: boolean,
) {
  return { ...body, cache: { ...meta, hit } }
}

/** S3 から取ったばかりの一覧を cache に入れ、その取得時刻を付けて返す。
 *  cache への書き込みに失敗しても応答は返すので、時刻は今から組む。 */
async function storeFreshList({ cache, scope, body, ttlSec }: {
  cache: ResponseCache
  scope: CacheScope
  body: ListBody
  ttlSec: number
}) {
  const now = new Date()
  const meta = await cache.set(scope, body, ttlSec * 1000) ?? {
    fetchedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlSec * 1000).toISOString(),
  }
  return withCacheMeta(body, meta, false)
}

/** ディレクトリを開いたとき (prefix が `/` 終わり) に S3 互換実装が返す
 *  「そのディレクトリ自身」を表す 0 バイトの placeholder オブジェクト
 *  (Key === prefix) を一覧から隠すための判定。
 *
 *  prefix が `/` で終わらない場合 (= S3PathPanel でフルキー / 部分キーを
 *  入力した検索) は、Key === prefix は「探しているファイルそのもの」なので
 *  隠してはいけない。ここを一律 `Key !== prefix` で弾いていたために、
 *  完全なオブジェクトキーを検索すると 0 件になるバグがあった。 */
function isSelfPlaceholder(key: string, prefix: string): boolean {
  return prefix.endsWith('/') && key === prefix
}

/** ListObjects (V1 / V2) の応答から一覧本文を組む。
 *  次ページの手掛かりは V1 が marker、V2 が continuation token で形が違うので呼び出し側が渡す。
 *  truncated なのに手掛かりを返さない S3 互換実装があるので、その場合は最終キーを startAfter にする。 */
function listBodyFrom(
  out: Pick<ListObjectsV2CommandOutput, 'CommonPrefixes' | 'Contents' | 'IsTruncated'>,
  prefix: string,
  next: { continuation: string | null; startAfter: string | null },
) {
  const truncated = out.IsTruncated === true
  const rawContents = out.Contents ?? []
  const fallbackKey = !next.continuation && !next.startAfter && truncated && rawContents.length > 0
    ? rawContents[rawContents.length - 1].Key ?? null
    : null
  return {
    directories: (out.CommonPrefixes ?? [])
      .map(p => p.Prefix!)
      .filter(Boolean),
    files: rawContents
      .filter(o => o.Key && !isSelfPlaceholder(o.Key, prefix))
      .map(o => ({
        key: o.Key!,
        size: o.Size ?? 0,
        lastModified: o.LastModified?.toISOString() ?? null,
      })),
    nextContinuation: next.continuation,
    nextStartAfter: next.startAfter ?? fallbackKey,
  }
}

export function mountStorageListRoutes(app: Hono, deps: StorageListDeps): void {
  app.get('/storage/:connectionId/buckets', async c => {
    // フェーズごとに所要時間を JSON ログに出して、
    // 「buckets が遅い」ときに getStorage / S3 の ListBuckets / 全体の
    // どこに時間がかかっているか切り分けられるようにする。
    const t0 = Date.now()
    const r = await resolveStorageOrFail(c, deps.getStorage)
    const t1 = Date.now()
    if (r instanceof Response) return r
    const storage = r
    const scope: CacheScope = { kind: 'buckets', connectionId: c.req.param('connectionId') }
    const refresh = c.req.query('refresh') === '1'
    if (!refresh) {
      const hit = await deps.cache.get(scope)
      if (hit) return c.json(hit.payload)
    }

    const out = await storage.send(new ListBucketsCommand({}))
    const t2 = Date.now()
    console.log(JSON.stringify({
      ev: 'storage.buckets.timing',
      connectionId: c.req.param('connectionId'),
      getStorage_ms: t1 - t0,
      listBuckets_ms: t2 - t1,
      total_ms: t2 - t0,
      bucketCount: out.Buckets?.length ?? 0,
    }))
    const body = {
      buckets: (out.Buckets ?? []).map(b => ({
        name: b.Name!,
        creationDate: b.CreationDate?.toISOString() ?? null,
      })),
    }
    await deps.cache.set(scope, body)
    return c.json(body)
  })

  app.get('/storage/:connectionId/list', async c => {
    const connectionId = c.req.param('connectionId')
    const r = await resolveStorageOrFail(c, deps.getStorage)
    if (r instanceof Response) return r
    const storage = r
    const bucket = c.req.query('bucket')
    if (!bucket) return c.json({ error: 'bucket is required' }, 400)
    const prefix = c.req.query('prefix') ?? ''
    const continuation = c.req.query('continuation') || undefined
    const startAfter = c.req.query('startAfter') || undefined
    // recursive=1 のときは Delimiter を外し、prefix 配下を flat に列挙する。
    // これは UI 側の「再帰検索」チェックボックスから来る。CommonPrefixes は
    // 空になるので結果は全部 Contents に並ぶ。
    const recursive = c.req.query('recursive') === '1'

    const scope: CacheScope = {
      kind: 'list', connectionId, bucket, prefix, recursive, continuation, startAfter,
    }
    const refresh = c.req.query('refresh') === '1'
    if (!refresh) {
      const hit = await deps.cache.get(scope)
      if (hit) {
        return c.json(withCacheMeta(
          hit.payload as ListBody,
          { fetchedAt: hit.fetchedAt, expiresAt: hit.expiresAt },
          true,
        ))
      }
    }

    const config = await deps.getConnectionConfig(connectionId)
    const isListObjectsV1 = config.listObjectsVersion === 'v1'

    // V1 / V2 で送るパラメータも応答の cursor フィールドも違うので、ここで分岐する。
    // V1 (?marker=…&prefix=…&delimiter=/): V1 only の S3 互換サーバ。
    //   応答に <NextMarker> が入る (Delimiter 指定時)。Delimiter 無しでは
    //   IsTruncated=true でも NextMarker 無しになることがあり、その場合は
    //   最後のキーで marker フォールバックする (s3cmd と同じ手法)。
    // V2 (?list-type=2&prefix=…&continuation-token=…): AWS / R2 / MinIO 推奨。
    //   ContinuationToken (不透明文字列) で次ページを指す。互換実装で
    //   NextContinuationToken が欠けている場合に最終キーを startAfter としてフォールバック。
    if (isListObjectsV1) {
      const marker = startAfter ?? continuation
      const out = await storage.send(new ListObjectsCommand({
        Bucket: bucket,
        Prefix: prefix,
        Delimiter: recursive ? undefined : '/',
        Marker: marker,
        MaxKeys: 100,
      }))
      // V1 には continuation token 概念が無い。pagination は marker (= startAfter) で。
      const body = listBodyFrom(out, prefix, { continuation: null, startAfter: out.NextMarker ?? null })
      return c.json(await storeFreshList({ cache: deps.cache, scope, body, ttlSec: config.listCacheTtlSec }))
    }

    // V2 経路 (既定): 既存挙動を保持。
    const out = await storage.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      Delimiter: recursive ? undefined : '/',
      // ContinuationToken 優先 (高速)。無いときだけ StartAfter で再開する。
      // S3 仕様上 ContinuationToken を渡すと StartAfter は無視されるが、
      // どちらか一方しか送らないほうが意図が明確。
      ContinuationToken: continuation,
      StartAfter: continuation ? undefined : startAfter,
      MaxKeys: 100,
    }))
    // 一部の S3 互換実装は IsTruncated=true を返すのに
    // NextContinuationToken を返さないことがある。その場合に最終キーで
    // フォールバック。AWS 公式 S3 では NextContinuationToken が常に入る
    // ので nextStartAfter は null のままになる。
    // ★ ただしこの fallback は V2 自体を理解しないサーバには効かない
    //   (start-after parameter を無視するため)。そういうサーバは接続設定で
    //   list_objects_version='v1' を選んでもらう。
    const body = listBodyFrom(out, prefix, { continuation: out.NextContinuationToken ?? null, startAfter: null })
    return c.json(await storeFreshList({ cache: deps.cache, scope, body, ttlSec: config.listCacheTtlSec }))
  })
}
