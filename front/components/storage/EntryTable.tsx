import { memo, useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import { Link } from 'react-router-dom'
import type { z } from 'zod'
import { api } from '../../lib/api/client'
import { classify } from '../../lib/api/mime'
import { StorageList } from '../../lib/api/types'
import { fmtSize } from '../../lib/format'
import { absoluteUrl, encPath } from '../../lib/route'
import { usePlayerDeck } from '../../lib/playerDeck'
import { usePinnedPreviews } from '../../lib/pinnedPreviews'
import { useCapabilities } from '../../lib/useCapabilities'
import type { Tag } from '../../lib/api/types'
import { CopyMenu, type MenuItem } from '../CopyMenu'
import { TagBadge } from '../TagBadge'
import { TagPicker } from '../TagPicker'

// タグは名前の「右」ではなく「下」に別行で出す。右に並べると、長いキーほど
// 名前側の truncate / break-all が効いてファイル名・ディレクトリ名が読めなく
// なるため。呼び出し側は glyph の隣の列 (名前と同じ列) に置いて字下げを揃える。
function TagRow({ tags }: { tags: Tag[] }) {
  if (tags.length === 0) return null
  return (
    <span className="mt-1 flex flex-wrap gap-1">
      {tags.map(t => <TagBadge key={t.id} tag={t} />)}
    </span>
  )
}

// <sm (= 640px 未満、phones) で card list、それ以上で table。
// CSS の `hidden sm:block` で両方を DOM に置くと jsdom + Testing Library が
// 同じ key の要素を複数ヒットしてしまうので、matchMedia を購読して片方だけ
// 描画する。SSR / 初期描画は desktop 既定 (matches=true) として扱う。
const COMPACT_QUERY = '(max-width: 639.98px)'
function useIsCompact(): boolean {
  const get = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(COMPACT_QUERY).matches
    : false
  const [isCompact, setIsCompact] = useState(get)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(COMPACT_QUERY)
    const handler = (): void => setIsCompact(mql.matches)
    mql.addEventListener('change', handler)
    setIsCompact(mql.matches)
    return () => mql.removeEventListener('change', handler)
  }, [])
  return isCompact
}

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
  d, prefix, connId, bucket, allTags, tagIds, onTagsChange, tagsEnabled,
}: {
  d: string; prefix: string; connId: string; bucket: string
  allTags: Tag[]; tagIds: string[]; onTagsChange?: (path: string, tagIds: string[]) => void
  tagsEnabled: boolean
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  // 表示は現ディレクトリ基準で末尾を切る。検索中は effectivePrefix が
  // `prefix + q` だが、入っているキーは prefix で始まるのでそのまま slice。
  const tail = d.startsWith(prefix) ? d.slice(prefix.length) : d
  const dirHref = `/storage/${encodeURIComponent(connId)}/${encodeURIComponent(bucket)}/${encPath(d)}`
  const dirS3Url = `s3://${bucket}/${d}`
  const dirWebUrl = absoluteUrl(dirHref)
  const tags = tagsEnabled ? allTags.filter(t => tagIds.includes(t.id)) : []
  const items = useMemo<MenuItem[]>(() => [
    { kind: 'copy', label: 'Web URL をコピー', value: dirWebUrl },
    { kind: 'copy', label: 'S3 URL をコピー', value: dirS3Url },
    ...(tagsEnabled
      ? [{ kind: 'action' as const, label: 'タグを編集', onSelect: () => setPickerOpen(true) }]
      : []),
  ], [dirWebUrl, dirS3Url, tagsEnabled])
  return (
    <>
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
            <span className="min-w-0 flex-1">
              <span className="block truncate">{tail}</span>
              <TagRow tags={tags} />
            </span>
          </Link>
        </td>
        <td className={tdNumClass}>-</td>
        <td className={tdNumClass}>-</td>
        <td className={tdNumClass}>
          <CopyMenu items={items} />
        </td>
      </tr>
      {pickerOpen && (
        <TagPicker
          connId={connId} bucket={bucket} kind="prefix" path={d} label={tail}
          allTags={allTags} assignedTagIds={tagIds}
          onChange={next => onTagsChange?.(d, next)}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </>
  )
})

const FileRow = memo(function FileRow({
  f, prefix, connId, bucket, onSelectFile, allTags, tagIds, onTagsChange, tagsEnabled,
}: {
  f: FileEntry
  prefix: string
  connId: string
  bucket: string
  onSelectFile?: (key: string) => void
  allTags: Tag[]; tagIds: string[]; onTagsChange?: (path: string, tagIds: string[]) => void
  tagsEnabled: boolean
}) {
  const deck = usePlayerDeck()
  const pinned = usePinnedPreviews()
  const [pickerOpen, setPickerOpen] = useState(false)
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
  const webUrl = absoluteUrl(
    `/storage/${encodeURIComponent(connId)}/${encodeURIComponent(bucket)}/${encPath(prefix)}`
    + `?preview=${encodeURIComponent(f.key)}`,
  )
  const s3Url = `s3://${bucket}/${f.key}`
  const downloadUrl = api.downloadUrl(connId, bucket, f.key)
  const filename = f.key.split('/').pop() ?? 'file'
  const isAudio = classify(f.key) === 'audio'
  const caps = useCapabilities(connId)
  const tags = tagsEnabled ? allTags.filter(t => tagIds.includes(t.id)) : []
  const items = useMemo<MenuItem[]>(() => [
    // デッキ (同期再生) は音声本体を読むので preview 権限が要る。
    ...(isAudio && caps.preview ? [{
      kind: 'action' as const,
      label: 'デッキに追加',
      onSelect: () => deck.addTrack({
        label: filename, connId, bucket, key: f.key,
      }),
    }] : []),
    // 種別で出し分けない。中身を見るまでテキストかどうか分からないので、
    // 拡張子でゲートすると「ドロワーでは開けるのにピン留めできない」不揃いが残る。
    // バイナリをピンしてもカードに「プレビュー非対応」と出るだけで実害はない。
    {
      kind: 'action' as const,
      label: 'ピン留め',
      onSelect: () => pinned.addPin({ connId, bucket, key: f.key }),
    },
    ...(tagsEnabled
      ? [{ kind: 'action' as const, label: 'タグを編集', onSelect: () => setPickerOpen(true) }]
      : []),
    ...(caps.download
      ? [{ kind: 'download' as const, label: 'このファイルをダウンロード', href: downloadUrl, filename }]
      : []),
    { kind: 'copy',     label: 'Web URL をコピー',           value: webUrl },
    { kind: 'copy',     label: 'S3 URL をコピー',            value: s3Url },
  ], [isAudio, caps.preview, caps.download, tagsEnabled, deck, pinned, connId, bucket, f.key, downloadUrl, webUrl, s3Url, filename])
  return (
    <>
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
            <span className="min-w-0 flex-1">
              <span
                className="block truncate text-ink-11"
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '12.5px',
                  letterSpacing: '0.005em',
                }}
              >
                {tail}
              </span>
              <TagRow tags={tags} />
            </span>
          </span>
        </td>
        <td className={tdNumClass}>{fmtSize(f.size)}</td>
        <td className={tdNumClass}>{f.lastModified?.slice(0, 10) ?? ''}</td>
        <td className={tdNumClass}>
          <CopyMenu items={items} />
        </td>
      </tr>
      {pickerOpen && (
        <TagPicker
          connId={connId} bucket={bucket} kind="file" path={f.key} label={tail}
          allTags={allTags} assignedTagIds={tagIds}
          onChange={next => onTagsChange?.(f.key, next)}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </>
  )
})

// ── Mobile card variants ───────────────────────────────────────
// <sm では table を card list に切替。table の横スクロールでは長いキー名が
// 一行に収まらず読みにくいので、カード上で 2 段組 (name / meta) に展開する。
const DirCard = memo(function DirCard({
  d, prefix, connId, bucket, allTags, tagIds, onTagsChange, tagsEnabled,
}: {
  d: string; prefix: string; connId: string; bucket: string
  allTags: Tag[]; tagIds: string[]; onTagsChange?: (path: string, tagIds: string[]) => void
  tagsEnabled: boolean
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const tail = d.startsWith(prefix) ? d.slice(prefix.length) : d
  const dirHref = `/storage/${encodeURIComponent(connId)}/${encodeURIComponent(bucket)}/${encPath(d)}`
  const dirS3Url = `s3://${bucket}/${d}`
  const dirWebUrl = absoluteUrl(dirHref)
  const tags = tagsEnabled ? allTags.filter(t => tagIds.includes(t.id)) : []
  const items = useMemo<MenuItem[]>(() => [
    { kind: 'copy', label: 'Web URL をコピー', value: dirWebUrl },
    { kind: 'copy', label: 'S3 URL をコピー', value: dirS3Url },
    ...(tagsEnabled
      ? [{ kind: 'action' as const, label: 'タグを編集', onSelect: () => setPickerOpen(true) }]
      : []),
  ], [dirWebUrl, dirS3Url, tagsEnabled])
  return (
    <li
      className="transition-colors hover:bg-ink-0 focus-within:bg-ink-1"
      style={{ borderBottom: '1px solid var(--rule)' }}
    >
      <div className="flex items-baseline gap-2 px-2 py-3">
        <Link
          to={dirHref}
          className="flex-1 min-w-0 flex items-baseline gap-2 font-semibold text-ink-12 no-underline"
        >
          <span aria-hidden className="text-ink-5 select-none text-[10px]">▸</span>
          <span className="min-w-0 flex-1">
            <span className="block break-all">{tail}</span>
            <TagRow tags={tags} />
          </span>
        </Link>
        <CopyMenu items={items} />
      </div>
      {pickerOpen && (
        <TagPicker
          connId={connId} bucket={bucket} kind="prefix" path={d} label={tail}
          allTags={allTags} assignedTagIds={tagIds}
          onChange={next => onTagsChange?.(d, next)}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </li>
  )
})

const FileCard = memo(function FileCard({
  f, prefix, connId, bucket, onSelectFile, allTags, tagIds, onTagsChange, tagsEnabled,
}: {
  f: FileEntry
  prefix: string
  connId: string
  bucket: string
  onSelectFile?: (key: string) => void
  allTags: Tag[]; tagIds: string[]; onTagsChange?: (path: string, tagIds: string[]) => void
  tagsEnabled: boolean
}) {
  const deck = usePlayerDeck()
  const pinned = usePinnedPreviews()
  const [pickerOpen, setPickerOpen] = useState(false)
  const tail = f.key.startsWith(prefix) ? f.key.slice(prefix.length) : f.key
  const select = useCallback(() => onSelectFile?.(f.key), [onSelectFile, f.key])
  const onKeyDown = useCallback((e: KeyboardEvent<HTMLLIElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      select()
    }
  }, [select])
  const webUrl = absoluteUrl(
    `/storage/${encodeURIComponent(connId)}/${encodeURIComponent(bucket)}/${encPath(prefix)}`
    + `?preview=${encodeURIComponent(f.key)}`,
  )
  const s3Url = `s3://${bucket}/${f.key}`
  const downloadUrl = api.downloadUrl(connId, bucket, f.key)
  const filename = f.key.split('/').pop() ?? 'file'
  const isAudio = classify(f.key) === 'audio'
  const caps = useCapabilities(connId)
  const tags = tagsEnabled ? allTags.filter(t => tagIds.includes(t.id)) : []
  const items = useMemo<MenuItem[]>(() => [
    // デッキ (同期再生) は音声本体を読むので preview 権限が要る。
    ...(isAudio && caps.preview ? [{
      kind: 'action' as const,
      label: 'デッキに追加',
      onSelect: () => deck.addTrack({
        label: filename, connId, bucket, key: f.key,
      }),
    }] : []),
    // 種別で出し分けない。中身を見るまでテキストかどうか分からないので、
    // 拡張子でゲートすると「ドロワーでは開けるのにピン留めできない」不揃いが残る。
    // バイナリをピンしてもカードに「プレビュー非対応」と出るだけで実害はない。
    {
      kind: 'action' as const,
      label: 'ピン留め',
      onSelect: () => pinned.addPin({ connId, bucket, key: f.key }),
    },
    ...(tagsEnabled
      ? [{ kind: 'action' as const, label: 'タグを編集', onSelect: () => setPickerOpen(true) }]
      : []),
    ...(caps.download
      ? [{ kind: 'download' as const, label: 'このファイルをダウンロード', href: downloadUrl, filename }]
      : []),
    { kind: 'copy',     label: 'Web URL をコピー',           value: webUrl },
    { kind: 'copy',     label: 'S3 URL をコピー',            value: s3Url },
  ], [isAudio, caps.preview, caps.download, tagsEnabled, deck, pinned, connId, bucket, f.key, downloadUrl, webUrl, s3Url, filename])
  return (
    <li
      className="cursor-pointer transition-colors hover:bg-ink-0 focus-within:bg-ink-1"
      style={{ borderBottom: '1px solid var(--rule)' }}
      role="button"
      tabIndex={0}
      onClick={select}
      onKeyDown={onKeyDown}
    >
      <div className="flex items-start gap-2 px-2 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span aria-hidden className="text-ink-3 select-none text-[10px]">·</span>
            <span className="min-w-0 flex-1">
              <span
                className="block break-all text-ink-11"
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '12.5px',
                  letterSpacing: '0.005em',
                }}
              >
                {tail}
              </span>
              <TagRow tags={tags} />
            </span>
          </div>
          <div
            className="mt-1 ml-3 text-[11px] text-ink-7 tabular-nums"
            style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.02em' }}
          >
            <span>{fmtSize(f.size)}</span>
            {f.lastModified && (
              <>
                {' '}<span className="text-ink-3">·</span>{' '}
                <span>{f.lastModified.slice(0, 10)}</span>
              </>
            )}
          </div>
        </div>
        <CopyMenu items={items} />
      </div>
      {pickerOpen && (
        <TagPicker
          connId={connId} bucket={bucket} kind="file" path={f.key} label={tail}
          allTags={allTags} assignedTagIds={tagIds}
          onChange={next => onTagsChange?.(f.key, next)}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </li>
  )
})

interface Props {
  dirs: string[]
  files: FileEntry[]
  prefix: string
  connId: string
  bucket: string
  onSelectFile?: (key: string) => void
  allTags?: Tag[]
  /** タグ機能の全体トグル (Settings → 機能)。false ならタグ関連の導線を出さない。 */
  tagsEnabled?: boolean
  tagsByPath?: Record<string, string[]>
  onTagsChange?: (path: string, tagIds: string[]) => void
}

export function EntryTable({
  dirs, files, prefix, connId, bucket, onSelectFile,
  allTags = [], tagsByPath = {}, onTagsChange, tagsEnabled = true,
}: Props) {
  const isCompact = useIsCompact()
  if (isCompact) {
    return (
      <ul
        className="m-0 list-none p-0"
        style={{ borderTop: '1px solid var(--color-rule-strong)' }}
      >
        {dirs.map(d => (
          <DirCard
            key={d} d={d} prefix={prefix} connId={connId} bucket={bucket}
            allTags={allTags} tagIds={tagsByPath[d] ?? []} onTagsChange={onTagsChange}
            tagsEnabled={tagsEnabled}
          />
        ))}
        {files.map(f => (
          <FileCard
            key={f.key}
            f={f}
            prefix={prefix}
            connId={connId}
            bucket={bucket}
            onSelectFile={onSelectFile}
            allTags={allTags} tagIds={tagsByPath[f.key] ?? []} onTagsChange={onTagsChange}
            tagsEnabled={tagsEnabled}
          />
        ))}
      </ul>
    )
  }
  return (
    <div className="overflow-x-auto">
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
            <DirRow
              key={d} d={d} prefix={prefix} connId={connId} bucket={bucket}
              allTags={allTags} tagIds={tagsByPath[d] ?? []} onTagsChange={onTagsChange}
            tagsEnabled={tagsEnabled}
            />
          ))}
          {files.map(f => (
            <FileRow
              key={f.key}
              f={f}
              prefix={prefix}
              connId={connId}
              bucket={bucket}
              onSelectFile={onSelectFile}
              allTags={allTags} tagIds={tagsByPath[f.key] ?? []} onTagsChange={onTagsChange}
            tagsEnabled={tagsEnabled}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}
