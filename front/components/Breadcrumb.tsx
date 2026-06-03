import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useConnection } from '../lib/connectionContext'
import { encPath } from '../lib/route'
import { CopyMenu, type MenuItem } from './CopyMenu'

// 現在の bucket+prefix から「1階層上」へ移動する:
//   /storage/<conn>/b/voice/jp/  → /storage/<conn>/b/voice/
//   /storage/<conn>/b/voice/     → /storage/<conn>/b/
//   /storage/<conn>/b/           → /storage/<conn>/        (バケット一覧)
function parentPath(connId: string, bucket: string, prefix: string): string {
  const segs = prefix.split('/').filter(Boolean)
  if (segs.length === 0) return `/storage/${encodeURIComponent(connId)}/`
  const trimmed = segs.slice(0, -1)
  const parentPrefix = trimmed.length === 0 ? '' : trimmed.join('/') + '/'
  return `/storage/${encodeURIComponent(connId)}/${encodeURIComponent(bucket)}/${encPath(parentPrefix)}`
}

// editorial breadcrumb:
// ・パス segment は font-mono (ファイルシステム表現)
// ・separator は serif の "›"  (ink-3)
// ・親へ戻るボタンは hairline 罫の正方形
const linkClass =
  'text-ink-11 no-underline px-1.5 py-[2px] rounded-1 ' +
  'font-mono text-[12.5px] ' +
  'transition-colors hover:bg-ink-1'
const sepClass =
  'text-ink-5 px-[3px] font-serif select-none'

export function Breadcrumb({
  connId, bucket, prefix,
}: { connId: string; bucket: string; prefix: string }) {
  const connection = useConnection()
  const segments = prefix.split('/').filter(Boolean)

  // ヘッダの「現在地コピー」メニュー。行メニュー (EntryTable) と同じ MenuItem 形で、
  // 現在の bucket+prefix をそのまま渡す。Breadcrumb は StorageBucket でしか描画されず
  // 常に bucket を持つので、最浅でも s3://<bucket>/ (= bucket 直下、prefix='') になり、
  // 接続ルート (バケット一覧) には出ない。深い階層ではそのディレクトリ URL をコピーできる。
  const dirHref =
    `/storage/${encodeURIComponent(connId)}/${encodeURIComponent(bucket)}/${encPath(prefix)}`
  const copyItems = useMemo<MenuItem[]>(() => [
    { kind: 'copy', label: 'Web URL をコピー', value: `${window.location.origin}${dirHref}` },
    { kind: 'copy', label: 'S3 URL をコピー',  value: `s3://${bucket}/${prefix}` },
  ], [dirHref, bucket, prefix])

  return (
    <nav className="flex flex-wrap items-center gap-1 my-2" aria-label="パンくず">
      <Link
        className={
          'inline-flex h-7 w-7 items-center justify-center rounded-1 ' +
          'text-ink-9 no-underline transition-colors ' +
          'hover:bg-ink-1 hover:text-ink-12'
        }
        style={{ border: '1px solid var(--color-rule-strong)' }}
        to={parentPath(connId, bucket, prefix)}
        aria-label="親階層へ"
        title="親階層へ"
      >
        <span aria-hidden>↑</span>
      </Link>
      <CopyMenu
        items={copyItems}
        trigger="⧉"
        ariaLabel="このディレクトリの URL をコピー"
      />
      <Link
        className={`${linkClass} font-sans font-medium`}
        style={{ fontFamily: 'var(--font-sans)' }}
        to={`/storage/${encodeURIComponent(connId)}/`}
      >
        {connection.name}
      </Link>
      <span className={sepClass}>›</span>
      <Link
        className={linkClass}
        to={`/storage/${encodeURIComponent(connId)}/${encodeURIComponent(bucket)}/`}
      >
        {bucket}
      </Link>
      {segments.map((seg, i) => {
        const subPrefix = segments.slice(0, i + 1).join('/') + '/'
        return (
          <span key={subPrefix} className="contents">
            <span className={sepClass}>›</span>
            <Link
              className={linkClass}
              to={`/storage/${encodeURIComponent(connId)}/${encodeURIComponent(bucket)}/${encPath(subPrefix)}`}
            >
              {seg}
            </Link>
          </span>
        )
      })}
      {prefix && <span className={sepClass}>›</span>}
    </nav>
  )
}
