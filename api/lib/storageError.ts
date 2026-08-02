// AWS SDK / S3 / nginx-proxy 由来のエラーを、意味のある HTTP status と
// 「原因を追える」メッセージに翻訳する。
//
// 以前は短い定型文だけを返していたが、それだと切り分けができなかった:
//   ・403 が「credentials か bucket permissions を確認」としか出ず、
//     アクセスキーが違うのか ListBucket 権限が無いのか分からない
//   ・XML の deserialize 失敗を一律「一時的なプロキシエラー」と断定して
//     いたが、実際には R2 の権限不足など恒久的な設定ミスのことがある
// そこで、こちらの解釈に加えて S3 側が返した生のコードとメッセージを
// 必ず添える。
//
// ハマりがちなケース:
// - S3 アップストリームが nginx の HTML 502 ページを返す → AWS SDK の XML
//   パーサが「Expected closing tag 'hr' instead of 'body'」で死亡。
// - S3 が普通に 5xx を返した → error.$metadata.httpStatusCode が 5xx。
// - 認証 / 権限エラー → 403。

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
const MAX_DETAIL = 400

// S3 が返したコード / メッセージ / requestId を 1 行にまとめる。
// これが無いと「何が起きたか」がユーザにも我々にも分からない。
function detailOf(err: SdkErrorLike): string {
  const code = err.name && err.name !== 'Error' ? err.name : undefined
  const raw = err.message?.trim()
  const head = code && raw && raw !== code ? `${code}: ${raw}`
    : code ?? raw ?? 'no detail'
  const rid = err.$metadata?.requestId
  const withRid = rid ? `${head} (requestId=${rid})` : head
  return withRid.length > MAX_DETAIL ? `${withRid.slice(0, MAX_DETAIL)}…` : withRid
}

export function explainStorageError(e: unknown): ExplainedError | null {
  const err = e as SdkErrorLike
  const status = err.$metadata?.httpStatusCode
  const detail = detailOf(err)

  // NoSuchKey 系。呼び出し元で個別ハンドルしてないものはここで 404。
  if (err.name === 'NoSuchKey' || status === 404) {
    return { status: 404, message: `見つかりません (HTTP 404) — ${detail}` }
  }

  // S3 5xx (アップストリーム障害) — リトライ済の上で来てる。
  if (status && status >= 500) {
    return {
      status: 502,
      message: `ストレージ側がエラーを返しました (HTTP ${status}) — ${detail}`,
    }
  }

  // SDK の XML deserialize 失敗。プロキシの HTML エラーページのことも、
  // S3 互換の実装差で想定外の応答が返ることもある。原因を決めつけず、
  // 見たままを出して確認先だけ挙げる。
  //
  // $response が付いていても、エラーコード (err.name) が取れているなら
  // それは「ストレージが正しく返したエラー」であってパース失敗ではない。
  // 例: R2 の InvalidArgument: Credential access key has length 21。
  // ここに流すと「応答を解釈できませんでした」という誤った見出しが付く。
  const parseFailed =
    err.message?.includes('Deserialization') === true ||
    err.message?.includes('Expected closing tag') === true
  const hasS3Code = !!err.name && err.name !== 'Error'
  if (parseFailed || (err.$response != null && !hasS3Code)) {
    return {
      status: 502,
      message:
        `ストレージの応答を解釈できませんでした — ${detail}。` +
        'S3 互換でない応答 (プロキシの HTML エラーページ、権限不足時の独自応答など) ' +
        'が返っている可能性があります。エンドポイント / path-style / ' +
        'ListObjects バージョンの設定を確認してください。',
    }
  }

  // 403 (認証 / 権限)。アクセスキー自体が違うのか、権限が足りないのかは
  // S3 のコードで分かるので detail を必ず添える
  // (InvalidAccessKeyId / SignatureDoesNotMatch / AccessDenied など)。
  if (status === 403) {
    return {
      status: 502,
      message:
        `アクセスが拒否されました (HTTP 403) — ${detail}。` +
        'アクセスキーと、そのキーに付いた権限 (一覧取得には ListBucket 相当が要ります)、' +
        'バケット名 / リージョン / エンドポイントを確認してください。',
    }
  }

  // S3 関連エラーに見えない (ただの内部エラー等) → 呼び出し元の判断に委ねる。
  if (status == null && err.$response == null && !err.name?.startsWith('S3')) {
    return null
  }

  return {
    status: 500,
    message: `ストレージエラー${status ? ` (HTTP ${status})` : ''} — ${detail}`,
  }
}
