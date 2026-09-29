// AWS SDK / S3 由来のエラーをHTTP statusへ翻訳する。upstreamの生message、
// canonical request、request IDはcredentialや内部構成を含み得るため返さない。

import { BlockedEndpointError } from './endpoint-policy.js'

interface SdkErrorLike {
  name?: string
  message?: string
  $metadata?: { httpStatusCode?: number; requestId?: string }
  $response?: unknown
}

export interface ExplainedError {
  status: 400 | 403 | 404 | 409 | 500 | 502
  message: string
}

// 接続先が拒否するアドレスを指しているのは、Mado の接続設定の問題。直すのは管理者なので、
// 何をすればよいかを伝える。
const BLOCKED_ENDPOINT_MESSAGE =
  'この接続のエンドポイントは、接続を許可していないアドレスを指しています。接続設定でエンドポイントを直してください。'

// 我々が返す status。upstream の失敗は 502 に寄せる (404 だけは素通し) —
// クライアントから見て「mado の不具合」と「ストレージ側の応答」を
// 取り違えないようにするため。
function mapStatus(upstream: number | undefined): ExplainedError['status'] {
  if (upstream === 404) return 404
  if (upstream != null && upstream >= 500) return 502
  if (upstream === 403) return 502
  return 500
}

export function explainStorageError(e: unknown): ExplainedError | null {
  if (e instanceof BlockedEndpointError) return { status: 409, message: BLOCKED_ENDPOINT_MESSAGE }
  const err = e as SdkErrorLike
  const upstream = err.$metadata?.httpStatusCode
  // XML パースに失敗した場合、SDK はパーサの例外文をそのまま message に
  // 入れてくる ($metadata が付かないこともある)。それも S3 由来として扱う。
  const parseFailed =
    err.message?.includes('Deserialization') === true ||
    err.message?.includes('Expected closing tag') === true

  // S3 関連エラーに見えない (ただの内部エラー等) → 呼び出し元の判断に委ねる。
  if (upstream == null && err.$response == null && !parseFailed && !err.name?.startsWith('S3')) {
    return null
  }

  const status = mapStatus(upstream)
  return {
    status,
    message: status === 404 ? 'storage object not found'
      : status === 502 ? 'storage service error' : 'storage request failed',
  }
}
