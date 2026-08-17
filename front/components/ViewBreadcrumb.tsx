import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useConnection } from '../lib/connectionContext'
import { absoluteUrl } from '../lib/route'
import { CopyMenu, type MenuItem } from './CopyMenu'

// Storage 配下の「バケットではないビュー」(タグ検索など) 用のパンくず。
// バケット画面の Breadcrumb と同じ見た目・同じ並び (↑ / ⧉ / 接続名 › 現在地) に
// 揃えて、どの画面でも現在地の読み方が変わらないようにする。
//
// Breadcrumb と分けているのは、こちらが bucket / prefix を持たないため。
// S3 上の場所ではないので S3 URL は無く、コピーできるのは Web URL だけ。
const linkClass =
  'text-ink-11 no-underline px-1.5 py-[2px] rounded-1 ' +
  'font-mono text-[12.5px] ' +
  'transition-colors hover:bg-ink-1'
const sepClass = 'text-ink-5 px-[3px] font-serif select-none'

export function ViewBreadcrumb({
  connId, label, href,
}: {
  connId: string
  /** 現在地の表示名 (例: タグ検索) */
  label: string
  /** 現在地の URL。⧉ でコピーする Web URL の元にする */
  href: string
}) {
  const connection = useConnection()
  const indexHref = `/storage/${encodeURIComponent(connId)}/`

  const copyItems = useMemo<MenuItem[]>(() => [
    { kind: 'copy', label: 'Web URL をコピー', value: absoluteUrl(href) },
  ], [href])

  return (
    <nav className="my-2 flex flex-wrap items-center gap-1" aria-label="パンくず">
      <Link
        className={
          'inline-flex h-7 w-7 items-center justify-center rounded-1 ' +
          'text-ink-9 no-underline transition-colors ' +
          'hover:bg-ink-1 hover:text-ink-12'
        }
        style={{ border: '1px solid var(--color-rule-strong)' }}
        to={indexHref}
        aria-label="バケット一覧へ"
        title="バケット一覧へ"
      >
        <span aria-hidden>↑</span>
      </Link>
      <CopyMenu items={copyItems} trigger="⧉" ariaLabel="このページの URL をコピー" />
      <Link
        className={`${linkClass} font-sans font-medium`}
        style={{ fontFamily: 'var(--font-sans)' }}
        to={indexHref}
      >
        {connection.name}
      </Link>
      <span className={sepClass}>›</span>
      {/* 現在地はリンクにしない (自分自身へのリンクになるため)。 */}
      <span className={`${linkClass} font-sans font-medium`} style={{ fontFamily: 'var(--font-sans)' }}>
        {label}
      </span>
    </nav>
  )
}
