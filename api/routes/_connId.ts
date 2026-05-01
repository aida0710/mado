import type { S3Client } from '@aws-sdk/client-s3'
import type { Context } from 'hono'

export type GetStorage = (connId: string) => Promise<S3Client>

/**
 * Resolves the storage client for the `:connId` path param, or returns a Response
 * (400 / 404) ready to be sent back. Caller pattern:
 *
 *   const r = await resolveStorageOrFail(c, deps.getStorage)
 *   if (r instanceof Response) return r
 *   const storage = r
 */
export async function resolveStorageOrFail(
  c: Context,
  getStorage: GetStorage,
): Promise<S3Client | Response> {
  const connId = c.req.param('connId')
  if (!connId) return c.json({ error: 'connId required' }, 400)
  try {
    return await getStorage(connId)
  } catch (e) {
    if (e instanceof Error && (e as { code?: string }).code === 'NOT_FOUND') {
      return c.json({ error: 'connection not found' }, 404)
    }
    throw e
  }
}
