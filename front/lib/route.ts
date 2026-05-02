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
