// AWS SDK / S3 / nginx-proxy 由来のエラーを、ユーザに見せても害がない
// 短いメッセージと意味のある HTTP status に翻訳する。
//
// ハマりがちなケース:
//
// - S3 アップストリームが nginx の HTML 502 ページを返す → AWS SDK の XML
//   パーサが「Expected closing tag 'hr' instead of 'body'」で死亡。
//   error.message に「Deserialization」を含む or error.$response を持つ。
// - S3 が普通に 5xx を返した → error.$metadata.httpStatusCode が 5xx。
// - 認証エラー (期限切れ、削除されたユーザ等) → 403 が来る。

interface SdkErrorLike {
  name?: string
  message?: string
  $metadata?: { httpStatusCode?: number }
  $response?: unknown
}

export interface ExplainedError {
  status: 400 | 403 | 404 | 500 | 502
  message: string
}

export function explainStorageError(e: unknown): ExplainedError | null {
  const err = e as SdkErrorLike
  const status = err.$metadata?.httpStatusCode

  // NoSuchKey 系。呼び出し元で個別ハンドルしてないものはここで 404。
  if (err.name === 'NoSuchKey' || status === 404) {
    return { status: 404, message: 'not found' }
  }

  // S3 5xx (アップストリーム障害) — リトライ済の上で来てる。
  if (status && status >= 500) {
    return { status: 502, message: `S3 upstream error (HTTP ${status})` }
  }

  // SDK の XML deserialize 失敗。S3 の前段プロキシが HTML エラーページを
  // 返したケース。ユーザには 502 として「一時的なプロキシエラーかも」と。
  if (
    err.message?.includes('Deserialization') ||
    err.message?.includes('Expected closing tag') ||
    err.$response != null
  ) {
    return {
      status: 502,
      message: 'S3 upstream returned non-XML response (likely transient proxy error)',
    }
  }

  // S3 403 (認証 / 権限) — 設定ミスを示唆。
  if (status === 403) {
    return {
      status: 502,
      message: 'S3 access denied (check credentials and bucket permissions)',
    }
  }

  // S3 関連エラーに見えない (ただの内部エラー等) → 呼び出し元の判断に委ねる。
  if (status == null && err.$response == null && !err.name?.startsWith('S3')) {
    return null
  }

  return { status: 500, message: (err.message ?? 'storage error').slice(0, 200) }
}
