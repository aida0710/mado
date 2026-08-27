import { isIP } from 'node:net'
import type { RequestMetadata } from './auth-types.js'

interface HeaderReader {
  req: { header(name: string): string | undefined }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const NGINX_REQUEST_ID = /^[0-9a-f]{32}$/i

function normalizedRequestId(value: string | undefined): string | null {
  const requestId = value?.trim()
  if (!requestId) return null
  if (UUID.test(requestId)) return requestId
  // nginxの$request_idはrandomな32桁hex。PostgreSQL UUIDへ渡せる標準表記にする。
  if (NGINX_REQUEST_ID.test(requestId)) {
    return `${requestId.slice(0, 8)}-${requestId.slice(8, 12)}-${requestId.slice(12, 16)}-${requestId.slice(16, 20)}-${requestId.slice(20)}`
  }
  return null
}

/**
 * Proxyが正規化したrequest metadataだけをDB型へ渡す。
 * 直接到達や設定ミスがあっても、client入力でaudit INSERTを壊さない。
 */
export function requestMetadata(c: HeaderReader): RequestMetadata {
  const forwarded = c.req.header('X-Forwarded-For')?.trim()
  return {
    ipAddress: forwarded && !forwarded.includes(',') && isIP(forwarded) !== 0 ? forwarded : null,
    userAgent: c.req.header('User-Agent')?.slice(0, 1024) ?? null,
    requestId: normalizedRequestId(c.req.header('X-Request-Id')),
  }
}
