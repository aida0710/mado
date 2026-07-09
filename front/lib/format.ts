// 複数コンポーネントで共有する表示フォーマッター。

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(1)} GB`
}

// プレビュー対象を人が読める 1 本の文字列にする。tar 内エントリは
// 「アーカイブ名 › エントリ名」、単体ファイルは key そのもの。
// 画面上は basename しか出さない (幅が足りない) ので、これは title 属性と
// クリップボードにだけ載る「省略しないフルパス」の唯一の出所。
export function fullEntryLabel(key: string, entryPath?: string): string {
  return entryPath != null ? `${key} › ${entryPath}` : key
}

// パスの末尾 (ファイル名)。区切りが無ければ入力そのもの。
export function basename(path: string): string {
  return path.split('/').pop() || path
}

export function fmtAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

// キャッシュの「いつ取得したか」表示用。長 TTL (6h) 内なら同日なので時刻のみ、
// 日付が変わってしまった場合は MM/DD HH:mm で日付も出す。
export function fmtCacheTime(d: Date): string {
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth()    === now.getMonth() &&
    d.getDate()     === now.getDate()
  if (sameDay) {
    return d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', hour12: false })
  }
  return d.toLocaleString('ja-JP', {
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
}
