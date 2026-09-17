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
