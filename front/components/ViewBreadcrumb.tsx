import { useMemo, type ReactNode } from 'react'
import { useConnection } from '../lib/connectionContext'
import { absoluteUrl } from '../lib/route'
import { StorageHeader } from './Breadcrumb'
import type { MenuItem } from './CopyMenu'

// Storage 配下の「バケットではないビュー」(タグ検索・容量メトリクス) の見出し。
// バケット画面の Breadcrumb と同じ形 (パンくず / h1 / 接続先の切り替え・コピー・上へ) に
// 揃えて、どの画面でも現在地の読み方が変わらないようにする。
//
// Breadcrumb と分けているのは、こちらが bucket / prefix を持たないため。
// S3 上の場所ではないので S3 URL は無く、コピーできるのは Web URL だけ。
// 上の階層はバケット一覧。
export function ViewBreadcrumb({
  connectionId, label, href, description,
}: {
  connectionId: string
  /** 現在地の表示名 (h1。例: タグ検索) */
  label: string
  /** 現在地の URL。コピーする Web URL の元にする */
  href: string
  /** h1 の下の補足 */
  description?: ReactNode
}) {
  const connection = useConnection()
  const indexHref = `/storage/${encodeURIComponent(connectionId)}/`

  const copyItems = useMemo<MenuItem[]>(() => [
    { kind: 'copy', label: 'Web URL をコピー', value: absoluteUrl(href) },
  ], [href])

  // 現在地 (h1) はリンクにしない (自分自身へのリンクになるため)。
  return (
    <StorageHeader
      crumbs={[{ label: connection.name, to: indexHref }]}
      title={label}
      description={description}
      copyItems={copyItems}
      copyLabel="このページの URL をコピー"
      upHref={indexHref}
      upLabel="バケット一覧へ"
    />
  )
}
