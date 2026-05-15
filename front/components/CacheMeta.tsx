// キャッシュ済みデータの「いつ取得したか」を薄く表示する小さなインラインタグ。
// 各画面 (StorageBrowser / ReadmeView / StorageIndex / PreviewArchive) の
// refresh ボタン周辺に置く。
//
// fetchedAt=null のときは何も描画しない (初回ロード前 / invalidate 直後)。
// 同日なら HH:mm、日跨ぎの場合は MM/DD HH:mm を fmtCacheTime() が選ぶ。

import { fmtCacheTime } from '../lib/format'

interface Props {
  fetchedAt: Date | null
}

export function CacheMeta({ fetchedAt }: Props) {
  if (!fetchedAt) return null
  const iso = fetchedAt.toISOString()
  return (
    <span
      className="cache-meta"
      title={`このデータが取得された時刻: ${iso}`}
      aria-label={`キャッシュ取得時刻 ${iso}`}
    >
      取得 {fmtCacheTime(fetchedAt)}
    </span>
  )
}
