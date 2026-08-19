// 複数コンポーネントで共有する表示フォーマッター。

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  if (n < 1024 ** 4) return `${(n / 1024 ** 3).toFixed(1)} GB`
  // 配下の集計で TB / PB 規模を扱う (dataset は 774 TB)。GB 頭打ちだと
  // 「793,530.4 GB」になって桁が読めない。
  if (n < 1024 ** 5) return `${(n / 1024 ** 4).toFixed(1)} TB`
  return `${(n / 1024 ** 5).toFixed(1)} PB`
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

// 一覧ヘッダ上の CacheBanner 用。「2026/08/18 16:14(2時間前)」のように
// 絶対時刻と相対時刻を併記する。絶対時刻だけだと「古いのか」が瞬時に分からず、
// 相対時刻だけだと正確な時点が分からないので両方出す。
//
// now を引数に取るのはテストのため。呼び出し側は省略してよい。
export interface CacheAgeOptions {
  /** 日付を省いて狭い場所に収める。同日なら HH:mm、日跨ぎなら MM/DD HH:mm。 */
  compact?: boolean
}

export function fmtCacheAge(d: Date, now: Date = new Date(), opts: CacheAgeOptions = {}): string {
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()

  // compact でも日を跨いだら日付を出す。時刻だけでは「昨日の 22:13」と
  // 区別が付かず、古いデータを新しいと誤読させてしまう。
  const abs = opts.compact
    ? (sameDay
        ? d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', hour12: false })
        : d.toLocaleString('ja-JP', {
            month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
          }))
    : d.toLocaleString('ja-JP', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
      })

  const min = Math.floor((now.getTime() - d.getTime()) / 60_000)
  const rel =
    min < 1  ? 'たった今'
    : min < 60 ? `${min}分前`
    : min < 60 * 24 ? `${Math.floor(min / 60)}時間前`
    : `${Math.floor(min / (60 * 24))}日前`
  return `${abs}(${rel})`
}


// .json (単一ドキュメント) だけプリティプリントする。.jsonl / .ndjson は
// 1 行 1 JSON 値の形式なのでそのまま返す。整形できない (不正な JSON) ときも
// そのまま返し、プレビューが空にならないようにする。
//
// これは表示上の整形であって、プレビューの描画先を決める分岐ではない
// (種別は中身のスニッフで決める。front/lib/textSniff.ts を参照)。
export function prettyPrintJson(name: string, text: string): string {
  const lower = name.toLowerCase()
  // .jsonl / .ndjson は末尾 5 文字が "jsonl" で ".json" と一致しないため、
  // .json だけを見る 1 条件で両方とも自然に弾ける (2 つめの endsWith('.jsonl') は不要)。
  if (!lower.endsWith('.json')) return text
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}
