import {
  ListBucketsCommand,
  ListObjectsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3'
import type { Hono } from 'hono'
import { resolveStorageOrFail, type GetStorage } from './_connId.js'
import type { ConnectionConfig } from '../storage.js'

export interface StorageListDeps {
  getStorage: GetStorage
  /** 接続ごとの API 設定 (list_objects_version 等) を返す。
   *  V1 only サーバ (DDN/MDX 等) には v1、それ以外 (AWS/R2/MinIO) は v2 を使う。 */
  getConnectionConfig: (connId: string) => Promise<ConnectionConfig>
}

export function mountStorageListRoutes(app: Hono, deps: StorageListDeps): void {
  app.get('/storage/:connId/buckets', async c => {
    // フェーズごとに所要時間を JSON ログに出して、
    // 「buckets が遅い」ときに getStorage / S3 の ListBuckets / 全体の
    // どこに時間がかかっているか切り分けられるようにする。
    const t0 = Date.now()
    const r = await resolveStorageOrFail(c, deps.getStorage)
    const t1 = Date.now()
    if (r instanceof Response) return r
    const storage = r
    const out = await storage.send(new ListBucketsCommand({}))
    const t2 = Date.now()
    console.log(JSON.stringify({
      ev: 'storage.buckets.timing',
      connId: c.req.param('connId'),
      getStorage_ms: t1 - t0,
      listBuckets_ms: t2 - t1,
      total_ms: t2 - t0,
      bucketCount: out.Buckets?.length ?? 0,
    }))
    return c.json({
      buckets: (out.Buckets ?? []).map(b => ({
        name: b.Name!,
        creationDate: b.CreationDate?.toISOString() ?? null,
      })),
    })
  })

  app.get('/storage/:connId/list', async c => {
    const connId = c.req.param('connId')
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

    const config = await deps.getConnectionConfig(connId)
    const useV1 = config.listObjectsVersion === 'v1'

    // V1 / V2 で送るパラメータも応答の cursor フィールドも違うので、ここで分岐する。
    // V1 (?marker=…&prefix=…&delimiter=/): MDX や古い NetApp 等の V1 only サーバ。
    //   応答に <NextMarker> が入る (Delimiter 指定時)。Delimiter 無しでは
    //   IsTruncated=true でも NextMarker 無しになることがあり、その場合は
    //   最後のキーで marker フォールバックする (s3cmd と同じ手法)。
    // V2 (?list-type=2&prefix=…&continuation-token=…): AWS / R2 / MinIO 推奨。
    //   ContinuationToken (不透明文字列) で次ページを指す。互換実装で
    //   NextContinuationToken が欠けている場合に最終キーを startAfter としてフォールバック。
    if (useV1) {
      const marker = startAfter ?? continuation
      const out = await storage.send(new ListObjectsCommand({
        Bucket: bucket,
        Prefix: prefix,
        Delimiter: recursive ? undefined : '/',
        Marker: marker,
        MaxKeys: 100,
      }))
      const explicitNext = out.NextMarker ?? null
      const truncated = out.IsTruncated === true
      const rawContents = out.Contents ?? []
      const fallbackKey = !explicitNext && truncated && rawContents.length > 0
        ? rawContents[rawContents.length - 1].Key ?? null
        : null
      return c.json({
        directories: (out.CommonPrefixes ?? [])
          .map(p => p.Prefix!)
          .filter(Boolean),
        files: rawContents
          .filter(o => o.Key && o.Key !== prefix)
          .map(o => ({
            key: o.Key!,
            size: o.Size ?? 0,
            lastModified: o.LastModified?.toISOString() ?? null,
          })),
        // V1 には continuation token 概念が無い。pagination は marker (= startAfter) で。
        nextContinuation: null,
        nextStartAfter: explicitNext ?? fallbackKey,
      })
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
    // DDN 互換 S3 (mdx 等) は IsTruncated=true を返すのに
    // NextContinuationToken を返さないことがある。その場合に最終キーで
    // フォールバック。AWS 公式 S3 では NextContinuationToken が常に入る
    // ので nextStartAfter は null のままになる。
    // ★ ただしこの fallback は MDX のように V2 自体を理解しないサーバには
    //   効かない (start-after parameter を無視するため)。そういうサーバは
    //   接続設定で list_objects_version='v1' を選んでもらう。
    const realToken = out.NextContinuationToken ?? null
    const truncated = out.IsTruncated === true
    const rawContents = out.Contents ?? []
    const fallbackKey = !realToken && truncated && rawContents.length > 0
      ? rawContents[rawContents.length - 1].Key ?? null
      : null
    return c.json({
      directories: (out.CommonPrefixes ?? [])
        .map(p => p.Prefix!)
        .filter(Boolean),
      files: rawContents
        .filter(o => o.Key && o.Key !== prefix)
        .map(o => ({
          key: o.Key!,
          size: o.Size ?? 0,
          lastModified: o.LastModified?.toISOString() ?? null,
        })),
      nextContinuation: realToken,
      nextStartAfter: fallbackKey,
    })
  })
}
