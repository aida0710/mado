import type { S3Client } from '@aws-sdk/client-s3'
import type { Context } from 'hono'

export type GetStorage = (connectionId: string) => Promise<S3Client>

/**
 * `:connectionId` パスパラメータに対応するストレージクライアントを解決する。
 * 失敗した場合はそのまま返せる Response (400 / 404) を返す。呼び出し元パターン:
 *
 *   const r = await resolveStorageOrFail(c, deps.getStorage)
 *   if (r instanceof Response) return r
 *   const storage = r
 */
export async function resolveStorageOrFail(
  c: Context,
  getStorage: GetStorage,
): Promise<S3Client | Response> {
  const connectionId = c.req.param('connectionId')
  if (!connectionId) return c.json({ error: 'connectionId required' }, 400)
  try {
    return await getStorage(connectionId)
  } catch (e) {
    if (e instanceof Error && (e as { code?: string }).code === 'NOT_FOUND') {
      return c.json({ error: 'connection not found' }, 404)
    }
    throw e
  }
}

export interface ObjectRequest {
  storage: S3Client
  bucket: string
  key: string
}

/**
 * `:connectionId` に加えて `?bucket=&key=` で 1 オブジェクトを指す request を解決する。
 * preview 系のように「接続 + バケット + キー」を必ず揃える route で使う。
 * 呼び出し元パターンは resolveStorageOrFail と同じで、Response が返ったらそのまま返す。
 */
export async function resolveObjectOrFail(
  c: Context,
  getStorage: GetStorage,
): Promise<ObjectRequest | Response> {
  const storage = await resolveStorageOrFail(c, getStorage)
  if (storage instanceof Response) return storage
  const bucket = c.req.query('bucket')
  const key = c.req.query('key')
  if (!bucket || !key) {
    return c.json({ error: 'bucket and key required' }, 400)
  }
  return { storage, bucket, key }
}
