import { memo, useCallback, useMemo, type KeyboardEvent } from 'react'
import { Link } from 'react-router-dom'
import type { z } from 'zod'
import { api } from '../../lib/api/client'
import { StorageList } from '../../lib/api/types'
import { fmtSize } from '../../lib/format'
import { encPath } from '../../lib/route'
import { CopyMenu, type MenuItem } from '../CopyMenu'

type ListResp = z.infer<typeof StorageList>
type FileEntry = ListResp['files'][number]

// Editorial table: ヘッダ small caps + 0.22em tracking、罫線は hairline (var(--rule))
const headThClass =
  'p-2 text-left text-[10.5px] font-semibold uppercase tracking-[0.22em] text-ink-7'
// 行内 cell。下端 hairline。tdNumClass は右寄せ + tabular-nums。
const tdNameClass =
  'max-w-0 overflow-hidden text-ellipsis whitespace-nowrap px-2 py-2.5'
const tdNumClass =
  'w-px whitespace-nowrap px-2 py-2.5 text-right tabular-nums text-ink-7 ' +
  'font-mono text-[12px]'
// File rows: 行全体クリック (preview drawer 開閉) なので pointer cursor
const fileRowClass =
  'cursor-pointer transition-colors hover:bg-ink-0 focus-within:bg-ink-1'
// Dir rows: クリック領域は内側の <Link> だけ。inert セルでは pointer を出さない
const dirRowClass =
  'transition-colors hover:bg-ink-0 focus-within:bg-ink-1'

// 行ごとに memo 化することで、StorageBrowser が loading フラグや scroll
// 起動の loadMore で再レンダしても、エントリが変わらない既存行は描画を
// スキップできる。各行は items: MenuItem[] を内部で useMemo して
// CopyMenu の memo を活かす。
const DirRow = memo(function DirRow({
  d, prefix, connId, bucket,
}: { d: string; prefix: string; connId: string; bucket: string }) {
  // 表示は現ディレクトリ基準で末尾を切る。検索中は effectivePrefix が
  // `prefix + q` だが、入っているキーは prefix で始まるのでそのまま slice。
  const tail = d.startsWith(prefix) ? d.slice(prefix.length) : d
  const dirHref = `/storage/${encodeURIComponent(connId)}/${encodeURIComponent(bucket)}/${encPath(d)}`
  const dirS3Url = `s3://${bucket}/${d}`
  const dirWebUrl = `${window.location.origin}${dirHref}`
  const items = useMemo<MenuItem[]>(() => [
    { kind: 'copy', label: 'Web URL をコピー', value: dirWebUrl },
    { kind: 'copy', label: 'S3 URL をコピー', value: dirS3Url },
  ], [dirWebUrl, dirS3Url])
  return (
    <tr className={dirRowClass} style={{ borderBottom: '1px solid var(--rule)' }}>
      <td className={`${tdNameClass} p-0`}>
        <Link
          to={dirHref}
          className={
            'flex items-baseline gap-2 px-2 py-2.5 ' +
            'font-semibold text-ink-12 no-underline'
          }
        >
          {/* dir glyph: chevron — folder シンボルとしての editorial 表現 */}
          <span aria-hidden className="text-ink-5 select-none text-[10px]">▸</span>
          <span className="truncate">{tail}</span>
        </Link>
      </td>
      <td className={tdNumClass}>-</td>
      <td className={tdNumClass}>-</td>
      <td className={tdNumClass}>
        <CopyMenu items={items} />
      </td>
    </tr>
  )
})

const FileRow = memo(function FileRow({
  f, prefix, connId, bucket, onSelectFile,
}: {
  f: FileEntry
  prefix: string
  connId: string
  bucket: string
  onSelectFile?: (key: string) => void
}) {
  const tail = f.key.startsWith(prefix) ? f.key.slice(prefix.length) : f.key
  const select = useCallback(() => onSelectFile?.(f.key), [onSelectFile, f.key])
  // Enter / Space で preview を開く。dir 行は <Link> がネイティブで処理する。
  const onKeyDown = useCallback((e: KeyboardEvent<HTMLTableRowElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      select()
    }
  }, [select])
  // Web URL は dashboard origin + 現在ナビゲーション + ?preview=<key>。
  // 別ユーザに送ると「直リンクで preview drawer が開く」共有 URL になる。
  const webUrl = `${window.location.origin}`
    + `/storage/${encodeURIComponent(connId)}/${encodeURIComponent(bucket)}/${encPath(prefix)}`
    + `?preview=${encodeURIComponent(f.key)}`
  const s3Url = `s3://${bucket}/${f.key}`
  const downloadUrl = api.downloadUrl(connId, bucket, f.key)
  const filename = f.key.split('/').pop() ?? 'file'
  const items = useMemo<MenuItem[]>(() => [
    { kind: 'download', label: 'このファイルをダウンロード', href: downloadUrl, filename },
    { kind: 'copy',     label: 'Web URL をコピー',           value: webUrl },
    { kind: 'copy',     label: 'S3 URL をコピー',            value: s3Url },
  ], [downloadUrl, webUrl, s3Url, filename])
  return (
    <tr
      className={fileRowClass}
      style={{ borderBottom: '1px solid var(--rule)' }}
      role="button"
      tabIndex={0}
      onClick={select}
      onKeyDown={onKeyDown}
    >
      <td className={tdNameClass}>
        <span className="flex items-baseline gap-2">
          {/* file glyph: 控えめな点 — タイポ的に存在を主張しすぎない */}
          <span aria-hidden className="text-ink-3 select-none text-[10px]">·</span>
          <span
            className="truncate text-ink-11"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '12.5px',
              letterSpacing: '0.005em',
            }}
          >
            {tail}
          </span>
        </span>
      </td>
      <td className={tdNumClass}>{fmtSize(f.size)}</td>
      <td className={tdNumClass}>{f.lastModified?.slice(0, 10) ?? ''}</td>
      <td className={tdNumClass}>
        <CopyMenu items={items} />
      </td>
    </tr>
  )
})

interface Props {
  dirs: string[]
  files: FileEntry[]
  prefix: string
  connId: string
  bucket: string
  onSelectFile?: (key: string) => void
}

export function EntryTable({ dirs, files, prefix, connId, bucket, onSelectFile }: Props) {
  return (
    <table className="w-full border-collapse text-[13px]">
      <thead>
        <tr style={{ borderBottom: '1px solid var(--color-rule-strong)' }}>
          <th className={headThClass}>Name</th>
          <th className={`${headThClass} text-right`}>Size</th>
          <th className={`${headThClass} text-right`}>Modified</th>
          <th className={headThClass}></th>
        </tr>
      </thead>
      <tbody>
        {dirs.map(d => (
          <DirRow key={d} d={d} prefix={prefix} connId={connId} bucket={bucket} />
        ))}
        {files.map(f => (
          <FileRow
            key={f.key}
            f={f}
            prefix={prefix}
            connId={connId}
            bucket={bucket}
            onSelectFile={onSelectFile}
          />
        ))}
      </tbody>
    </table>
  )
}
