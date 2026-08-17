// キャッシュ済みデータの「いつ取得したか」を薄く表示する小さなインラインタグ。
// 各画面 (StorageBrowser / ReadmeView / StorageIndex / PreviewArchive) の
// refresh ボタン周辺に置く。
//
// fetchedAt=null のときは何も描画しない (初回ロード前 / invalidate 直後)。
// 同日なら HH:mm、日跨ぎの場合は MM/DD HH:mm を fmtCacheTime() が選ぶ。
//
// revalidating=true は「今表示しているのは期限切れのキャッシュで、裏で最新を
// 取りに行っている」状態 (stale-while-revalidate)。時刻はキャッシュを取得した
// 時刻のままで、更新が届いた時点で新しい時刻に差し替わる。

import { fmtCacheTime } from '../lib/format'

interface Props {
  fetchedAt: Date | null
  /** 裏で再取得中か。true の間だけ「更新中…」を添える。 */
  revalidating?: boolean
}

export function CacheMeta({ fetchedAt, revalidating = false }: Props) {
  if (!fetchedAt) return null
  const iso = fetchedAt.toISOString()
  const label = revalidating
    ? `これはキャッシュされた情報です (${iso})。現在キャッシュを更新しています。`
    : `このデータが取得された時刻: ${iso}`
  return (
    <span className="cache-meta" title={label} aria-label={label}>
      取得 {fmtCacheTime(fetchedAt)}
      {revalidating ? <span className="cache-meta__revalidating"> · 更新中…</span> : null}
    </span>
  )
}
