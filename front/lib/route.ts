// Client-side ルーティング URL を組み立てる際のパス encode ヘルパー。
//
// React Router の URL は path-to-regexp 系で `?` `#` `%` `+` などを特別扱いするため、
// S3 キー名に由来する値を直接テンプレートに差し込むとルーティングが破損する。
// API クライアント (front/lib/api/client.ts) の fetch URL は別途 encodeURIComponent /
// URLSearchParams で処理済みなので、本ヘルパーは **画面遷移用 URL 構築でのみ** 使う。
//
// 単一セグメント (`/` を含まない値) は素直に encodeURIComponent を使う。

// 複数セグメントを `/` 区切りで保持したまま encode する。
// 例: `foo/bar baz/` → `foo/bar%20baz/`。末尾スラッシュ等の構造を保つ。
export function encPath(s: string): string {
  return s.split('/').map(encodeURIComponent).join('/')
}

export interface S3PathParts {
  bucket: string
  prefix: string
}

// `s3://bucket/a/b/` や `bucket/a/b` を { bucket, prefix } に分解する。
//
// - `s3://` スキームは大小文字問わず剥がす。先頭スラッシュも除去。
// - bucket = 最初の `/` まで。prefix = 残り (末尾スラッシュは構造として保持)。
// - bucket が取り出せない (空入力 / `s3://` だけ 等) 場合は null。
//
// 例:
//   's3://dataset/debug/x/'  → { bucket: 'dataset', prefix: 'debug/x/' }
//   's3://dataset'           → { bucket: 'dataset', prefix: '' }
//   'dataset/debug'          → { bucket: 'dataset', prefix: 'debug' }
//   ''                       → null
export function parseS3Path(input: string): S3PathParts | null {
  let s = input.trim()
  s = s.replace(/^s3:\/\//i, '')   // s3:// スキーム (大小文字寛容)
  s = s.replace(/^\/+/, '')        // 先頭スラッシュ
  if (s === '') return null
  const slash = s.indexOf('/')
  if (slash === -1) return { bucket: s, prefix: '' }
  return { bucket: s.slice(0, slash), prefix: s.slice(slash + 1) }
}

// ファイル直リンク (`/storage/<conn>/<bucket>/<...>/file.ext`) を、その親ディレクトリの
// リスト + `?preview=<key>` URL に書き換えるためのヘルパー。
//
// 例:
//   ('c1', 'b1', 'foo/bar/baz.txt')
//     → '/storage/c1/b1/foo/bar/?preview=foo%2Fbar%2Fbaz.txt'
//   ('c1', 'b1', 'baz.txt')     // bucket 直下のファイル
//     → '/storage/c1/b1/?preview=baz.txt'
//
// 使い所: README の Markdown リンクや別アプリ等で生成された直リンクから StorageBucket
// に飛んできた時、自動で「親ディレクトリの並び + プレビュードロワが開いた状態」に
// 切り替える (StorageBucket.tsx 側で <Navigate replace /> として実行)。
//
// fileKey は params['*'] から来た値で、React Router によって URL decode 済み前提。
export function fileLinkToDirRedirect(
  connId: string,
  bucket: string,
  fileKey: string,
): string {
  const lastSlash = fileKey.lastIndexOf('/')
  const parentPrefix = lastSlash >= 0 ? fileKey.slice(0, lastSlash + 1) : ''
  return (
    `/storage/${encodeURIComponent(connId)}` +
    `/${encodeURIComponent(bucket)}` +
    `/${encPath(parentPrefix)}` +
    `?preview=${encodeURIComponent(fileKey)}`
  )
}
