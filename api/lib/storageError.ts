// AWS SDK / S3 由来のエラーを、意味のある HTTP status と「ストレージが
// 実際に返した内容」に翻訳する。
//
// こちらで原因の解釈や対処の助言は書かない。以前は「一時的なプロキシ
// エラーかも」「credentials か bucket permissions を確認」といった文言を
// 付けていたが、実態とずれると誤誘導になる (R2 が鍵の長さの不備を返して
// いるのに「一時的」と読める、など)。status とストレージのコード / 生
// メッセージだけを出し、判断は見る人に任せる。

interface SdkErrorLike {
  name?: string
  message?: string
  $metadata?: { httpStatusCode?: number; requestId?: string }
  $response?: unknown
}

export interface ExplainedError {
  status: 400 | 403 | 404 | 500 | 502
  message: string
}

// 生メッセージの上限。SignatureDoesNotMatch は canonical request 全文を
// 抱えることがあり、そのまま出すと画面が埋まる。
const MAX_MESSAGE = 400

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

  const code = err.name && err.name !== 'Error' ? err.name : undefined
  const raw = err.message?.trim()
  const body = code && raw && raw !== code ? `${code}: ${raw}` : code ?? raw ?? 'no detail'
  const rid = err.$metadata?.requestId
  const parts = [
    upstream != null ? `HTTP ${upstream}` : null,
    body,
    rid ? `requestId=${rid}` : null,
  ].filter(Boolean)

  const message = parts.join(' — ')
  return {
    status: mapStatus(upstream),
    message: message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE)}…` : message,
  }
}
