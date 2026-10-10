import { Fragment, useMemo, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowUp, ChevronRight, Copy } from 'lucide-react'
import { useConnection } from '../lib/connectionContext'
import { absoluteUrl, encPath } from '../lib/route'
import { ConnectionSwitcher } from './ConnectionSwitcher'
import { CopyMenu, type MenuItem } from './CopyMenu'

export interface Crumb {
  label: string
  to: string
}

interface StorageHeaderProps {
  /** 今いる場所より上の階層。左から順に .eyebrow へリンクで並べる。 */
  crumbs: Crumb[]
  /** 今いる場所の名前 (h1)。 */
  title: ReactNode
  /** h1 の下の補足 (.page-description)。 */
  description?: ReactNode
  /** 「URL をコピー」メニューの項目。 */
  copyItems: MenuItem[]
  copyLabel: string
  /** 「上の階層へ」のリンク先と名前。 */
  upHref: string
  upLabel: string
}

/**
 * Storage の画面の見出し (共通の部品の .page-header)。上の .eyebrow にパンくず、h1 に今いる
 * 場所の名前、右の .page-actions に接続先の切り替え・URL のコピー・上の階層へ を並べる。
 * バケットの中 (Breadcrumb) とバケットではない画面 (ViewBreadcrumb) で同じ形にして、どの画面でも
 * 現在地の読み方を変えない。
 */
export function StorageHeader({
  crumbs, title, description, copyItems, copyLabel, upHref, upLabel,
}: StorageHeaderProps) {
  return (
    <header className="page-header">
      <div>
        <nav className="eyebrow storage-crumbs" aria-label="パンくず">
          {crumbs.map((crumb, index) => (
            <Fragment key={crumb.to}>
              {index > 0 && (
                <span className="breadcrumb-separator" aria-hidden="true">
                  <ChevronRight size={12} />
                </span>
              )}
              <Link to={crumb.to}>{crumb.label}</Link>
            </Fragment>
          ))}
        </nav>
        <h1>{title}</h1>
        {description && <div className="page-description">{description}</div>}
      </div>
      <div className="page-actions">
        <ConnectionSwitcher />
        <CopyMenu items={copyItems} trigger={<Copy size={16} aria-hidden="true" />} ariaLabel={copyLabel} />
        <Link className="icon-button" to={upHref} aria-label={upLabel} title={upLabel}>
          <ArrowUp size={16} aria-hidden="true" />
        </Link>
      </div>
    </header>
  )
}

// 現在の bucket+prefix から「1階層上」へ移動する:
//   /storage/<connectionId>/b/voice/jp/  → /storage/<connectionId>/b/voice/
//   /storage/<connectionId>/b/voice/     → /storage/<connectionId>/b/
//   /storage/<connectionId>/b/           → /storage/<connectionId>/        (バケット一覧)
function parentPath(connectionId: string, bucket: string, prefix: string): string {
  const segs = prefix.split('/').filter(Boolean)
  if (segs.length === 0) return `/storage/${encodeURIComponent(connectionId)}/`
  const trimmed = segs.slice(0, -1)
  const parentPrefix = trimmed.length === 0 ? '' : trimmed.join('/') + '/'
  return `/storage/${encodeURIComponent(connectionId)}/${encodeURIComponent(bucket)}/${encPath(parentPrefix)}`
}

/**
 * バケットの中 (一覧) の見出し。パンくずは 接続先 › バケット › 親のフォルダ…、h1 は今いる
 * フォルダの名前 (バケットの直下ならバケット名)。
 */
export function Breadcrumb({
  connectionId, bucket, prefix, description,
}: { connectionId: string; bucket: string; prefix: string; description?: ReactNode }) {
  const connection = useConnection()
  const segments = prefix.split('/').filter(Boolean)
  const indexHref = `/storage/${encodeURIComponent(connectionId)}/`
  const bucketHref = `${indexHref}${encodeURIComponent(bucket)}/`

  const crumbs: Crumb[] = [{ label: connection.name, to: indexHref }]
  if (segments.length > 0) {
    crumbs.push({ label: bucket, to: bucketHref })
    segments.slice(0, -1).forEach((segment, index) => {
      crumbs.push({ label: segment, to: bucketHref + encPath(segments.slice(0, index + 1).join('/') + '/') })
    })
  }

  // 見出しの「現在地コピー」メニュー。行メニュー (EntryTable) と同じ MenuItem 形で、
  // 現在の bucket+prefix をそのまま渡す。Breadcrumb は StorageBucket でしか描画されず
  // 常に bucket を持つので、最浅でも s3://<bucket>/ (= bucket 直下、prefix='') になり、
  // 接続ルート (バケット一覧) には出ない。深い階層ではそのディレクトリ URL をコピーできる。
  const dirHref = `${bucketHref}${encPath(prefix)}`
  const copyItems = useMemo<MenuItem[]>(() => [
    { kind: 'copy', label: 'Web URL をコピー', value: absoluteUrl(dirHref) },
    { kind: 'copy', label: 'S3 URL をコピー',  value: `s3://${bucket}/${prefix}` },
  ], [dirHref, bucket, prefix])

  return (
    <StorageHeader
      crumbs={crumbs}
      title={segments.at(-1) ?? bucket}
      description={description}
      copyItems={copyItems}
      copyLabel="このディレクトリの URL をコピー"
      upHref={parentPath(connectionId, bucket, prefix)}
      upLabel="親階層へ"
    />
  )
}
