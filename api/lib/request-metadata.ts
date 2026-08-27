import { isIP } from 'node:net'
import type { RequestMetadata } from './auth-types.js'

interface HeaderReader {
  req: { header(name: string): string | undefined }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Proxyが正規化したrequest metadataだけをDB型へ渡す。
 * 直接到達や設定ミスがあっても、client入力でaudit INSERTを壊さない。
 */
export function requestMetadata(c: HeaderReader): RequestMetadata {
  const forwarded = c.req.header('X-Forwarded-For')?.trim()
  const requestId = c.req.header('X-Request-Id')?.trim()
  return {
    ipAddress: forwarded && !forwarded.includes(',') && isIP(forwarded) !== 0 ? forwarded : null,
    userAgent: c.req.header('User-Agent')?.slice(0, 1024) ?? null,
    requestId: requestId && UUID.test(requestId) ? requestId : null,
  }
}
