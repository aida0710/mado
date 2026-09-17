import { memo } from 'react'
import { Link } from 'react-router-dom'
import type { StorageFileEntry, Tag } from '../../lib/api/types'
import { fmtSize } from '../../lib/format'
import { useIsCompact } from '../../lib/useIsCompact'
import { CopyMenu } from '../CopyMenu'
import { EntryLabel } from './EntryLabel'
import { EntryTagPicker } from './EntryTagPicker'
import { useDirectoryEntryActions, useFileEntryActions, type EntryTagProps } from './useEntryActions'

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
const hairline = { borderBottom: '1px solid var(--rule)' } as const

interface DirectoryEntryProps extends EntryTagProps {
  directory: string
  prefix: string
  connectionId: string
  bucket: string
  onTagsChange?: (path: string, tagIds: string[]) => void
}

interface FileEntryProps extends EntryTagProps {
  file: StorageFileEntry
  prefix: string
  connectionId: string
  bucket: string
  onSelectFile?: (key: string) => void
  onTagsChange?: (path: string, tagIds: string[]) => void
}

// 行ごとに memo 化することで、StorageBrowser が loading フラグや scroll
// 起動の loadMore で再レンダしても、エントリが変わらない既存行は描画を
// スキップできる。各行は items: MenuItem[] を内部で useMemo して
// CopyMenu の memo を活かす。
const DirectoryRow = memo(function DirectoryRow(props: DirectoryEntryProps) {
  const { directory, connectionId, bucket, allTags, tagIds, onTagsChange } = props
  const entry = useDirectoryEntryActions(props)
  return (
    <>
      <tr className={dirRowClass} style={hairline}>
        <td className={`${tdNameClass} p-0`}>
          <Link
            to={entry.href}
            className="flex items-baseline gap-2 px-2 py-2.5 font-semibold text-ink-12 no-underline"
          >
            <EntryLabel kind="directory" tail={entry.tail} tags={entry.tags} overflow="truncate" />
          </Link>
        </td>
        <td className={tdNumClass}>-</td>
        <td className={tdNumClass}>-</td>
        <td className={tdNumClass}>
          <CopyMenu items={entry.items} />
        </td>
      </tr>
      <EntryTagPicker
        open={entry.pickerOpen} onClose={() => entry.setPickerOpen(false)}
        connectionId={connectionId} bucket={bucket} kind="prefix" path={directory} label={entry.tail}
        allTags={allTags} tagIds={tagIds} onTagsChange={onTagsChange}
      />
    </>
  )
})

const FileRow = memo(function FileRow(props: FileEntryProps) {
  const { file, connectionId, bucket, allTags, tagIds, onTagsChange } = props
  const entry = useFileEntryActions(props)
  return (
    <>
      <tr
        className={fileRowClass}
        style={hairline}
        role="button"
        tabIndex={0}
        onClick={entry.select}
        onKeyDown={entry.onKeyDown}
      >
        <td className={tdNameClass}>
          <span className="flex items-baseline gap-2">
            <EntryLabel kind="file" tail={entry.tail} tags={entry.tags} overflow="truncate" />
          </span>
        </td>
        <td className={tdNumClass}>{fmtSize(file.size)}</td>
        <td className={tdNumClass}>{file.lastModified?.slice(0, 10) ?? ''}</td>
        <td className={tdNumClass}>
          <CopyMenu items={entry.items} />
        </td>
      </tr>
      <EntryTagPicker
        open={entry.pickerOpen} onClose={() => entry.setPickerOpen(false)}
        connectionId={connectionId} bucket={bucket} kind="file" path={file.key} label={entry.tail}
        allTags={allTags} tagIds={tagIds} onTagsChange={onTagsChange}
      />
    </>
  )
})

// ── Mobile card variants ───────────────────────────────────────
// <sm では table を card list に切替。table の横スクロールでは長いキー名が
// 一行に収まらず読みにくいので、カード上で 2 段組 (name / meta) に展開する。

const DirectoryCard = memo(function DirectoryCard(props: DirectoryEntryProps) {
  const { directory, connectionId, bucket, allTags, tagIds, onTagsChange } = props
  const entry = useDirectoryEntryActions(props)
  return (
    <li className={dirRowClass} style={hairline}>
      <div className="flex items-baseline gap-2 px-2 py-3">
        <Link
          to={entry.href}
          className="flex-1 min-w-0 flex items-baseline gap-2 font-semibold text-ink-12 no-underline"
        >
          <EntryLabel kind="directory" tail={entry.tail} tags={entry.tags} overflow="break-all" />
        </Link>
        <CopyMenu items={entry.items} />
      </div>
      <EntryTagPicker
        open={entry.pickerOpen} onClose={() => entry.setPickerOpen(false)}
        connectionId={connectionId} bucket={bucket} kind="prefix" path={directory} label={entry.tail}
        allTags={allTags} tagIds={tagIds} onTagsChange={onTagsChange}
      />
    </li>
  )
})

const FileCard = memo(function FileCard(props: FileEntryProps) {
  const { file, connectionId, bucket, allTags, tagIds, onTagsChange } = props
  const entry = useFileEntryActions(props)
  return (
    <li
      className={fileRowClass}
      style={hairline}
      role="button"
      tabIndex={0}
      onClick={entry.select}
      onKeyDown={entry.onKeyDown}
    >
      <div className="flex items-start gap-2 px-2 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <EntryLabel kind="file" tail={entry.tail} tags={entry.tags} overflow="break-all" />
          </div>
          <div
            className="mt-1 ml-3 text-[11px] text-ink-7 tabular-nums"
            style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.02em' }}
          >
            <span>{fmtSize(file.size)}</span>
            {file.lastModified && (
              <>
                {' '}<span className="text-ink-3">·</span>{' '}
                <span>{file.lastModified.slice(0, 10)}</span>
              </>
            )}
          </div>
        </div>
        <CopyMenu items={entry.items} />
      </div>
      <EntryTagPicker
        open={entry.pickerOpen} onClose={() => entry.setPickerOpen(false)}
        connectionId={connectionId} bucket={bucket} kind="file" path={file.key} label={entry.tail}
        allTags={allTags} tagIds={tagIds} onTagsChange={onTagsChange}
      />
    </li>
  )
})

interface Props {
  dirs: string[]
  files: StorageFileEntry[]
  prefix: string
  connectionId: string
  bucket: string
  onSelectFile?: (key: string) => void
  allTags?: Tag[]
  /** タグ機能の全体トグル (Settings → 機能)。false ならタグ関連の導線を出さない。 */
  tagsEnabled?: boolean
  tagsByPath?: Record<string, string[]>
  onTagsChange?: (path: string, tagIds: string[]) => void
}

export function EntryTable({
  dirs, files, prefix, connectionId, bucket, onSelectFile,
  allTags = [], tagsByPath = {}, onTagsChange, tagsEnabled = true,
}: Props) {
  const isCompact = useIsCompact()
  const shared = { prefix, connectionId, bucket, allTags, onTagsChange, tagsEnabled }
  if (isCompact) {
    return (
      <ul
        className="m-0 list-none p-0"
        style={{ borderTop: '1px solid var(--color-rule-strong)' }}
      >
        {dirs.map(d => (
          <DirectoryCard key={d} directory={d} tagIds={tagsByPath[d] ?? []} {...shared} />
        ))}
        {files.map(f => (
          <FileCard key={f.key} file={f} tagIds={tagsByPath[f.key] ?? []} onSelectFile={onSelectFile} {...shared} />
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
            <DirectoryRow key={d} directory={d} tagIds={tagsByPath[d] ?? []} {...shared} />
          ))}
          {files.map(f => (
            <FileRow key={f.key} file={f} tagIds={tagsByPath[f.key] ?? []} onSelectFile={onSelectFile} {...shared} />
          ))}
        </tbody>
      </table>
    </div>
  )
}
