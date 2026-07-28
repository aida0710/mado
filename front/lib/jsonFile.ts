// JSON ファイルの書き出し / 読み込み。タグと家系図のインポート / エクスポートで共用する。

// data URL ではなく Blob + createObjectURL を使う。JSON が大きくなったとき
// data URL は URL 長の上限に当たることがあるため。
export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // click() が終わってもブラウザが読み終わるまで少し猶予がいる。
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function readJsonFile(file: File): Promise<unknown> {
  const text = await file.text()
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error('JSON として読めませんでした。')
  }
}

// インポート結果のまとめ。「何件入って何件飛ばしたか」を必ず出すため、
// 呼び出し側で個別に数えずに済むようにこの形に揃える。
export interface ImportSummary {
  added: number
  /** 既に存在していて何もしなかった件数。 */
  skipped: number
  /** 置き換えモードで、ファイルに無いので消した件数。 */
  removed?: number
  /** 失敗した項目のメッセージ (先頭数件だけ見せる想定)。 */
  failed: string[]
}

export function summaryText(s: ImportSummary): string {
  const parts = [`追加 ${s.added} 件`, `スキップ ${s.skipped} 件`]
  if (s.removed) parts.push(`削除 ${s.removed} 件`)
  if (s.failed.length > 0) parts.push(`失敗 ${s.failed.length} 件`)
  return parts.join(' / ')
}

// 取り込み方法。
// - append:  ファイルにあるものを足すだけ。既存は触らない
// - replace: ファイルの内容に同期する。ファイルに無い既存は消す。
//            「全消し → 入れ直し」ではないので、両方にあるものは
//            id や作成者を保ったまま残る
export type ImportMode = 'append' | 'replace'
