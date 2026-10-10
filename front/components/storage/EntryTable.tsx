import { memo } from 'react'
import type { StorageFileEntry, Tag } from '../../lib/api/types'
import { fmtSize } from '../../lib/format'
import { useIsCompact } from '../../lib/useIsCompact'
import { CopyMenu } from '../CopyMenu'
import { EntryLabel } from './EntryLabel'
import { EntryTagPicker } from './EntryTagPicker'
import { useDirectoryEntryActions, useFileEntryActions, type EntryTagProps } from './useEntryActions'

// 一覧の表 (共通の部品の table)。1 行 40px 前後に詰め、名前の列にアイコン・名前・タグ、
// 右にサイズ・更新日、右端に操作のメニュー。ファイルの行は押すとプレビューを開く。
// 640px 未満は列を Name と操作だけにし、サイズ・更新日は名前の下の 1 行に回す。

interface RowLayout {
  /** 640px 未満の形 (列を減らす)。 */
  compact: boolean
}

interface DirectoryEntryProps extends EntryTagProps, RowLayout {
  directory: string
  prefix: string
  connectionId: string
  bucket: string
  onTagsChange?: (path: string, tagIds: string[]) => void
}

interface FileEntryProps extends EntryTagProps, RowLayout {
  file: StorageFileEntry
  prefix: string
  connectionId: string
  bucket: string
  /** プレビューで開いている行か (tr.selected)。 */
  selected: boolean
  onSelectFile?: (key: string) => void
  onTagsChange?: (path: string, tagIds: string[]) => void
}

// 行ごとに memo 化することで、StorageBrowser が loading フラグなどで再レンダしても、
// エントリが変わらない既存行は描画をスキップできる。各行は items: MenuItem[] を
// 内部で useMemo して CopyMenu の memo を活かす。
const DirectoryRow = memo(function DirectoryRow(props: DirectoryEntryProps) {
  const { directory, connectionId, bucket, allTags, tagIds, onTagsChange, compact } = props
  const entry = useDirectoryEntryActions(props)
  return (
    <>
      {/* クリック領域は名前のリンクだけ (中クリック・新しいタブが効く本物の <a>)。 */}
      <tr>
        <td>
          <EntryLabel kind="directory" tail={entry.tail} tags={entry.tags} href={entry.href} />
        </td>
        {!compact && <td className="numeric mono entry-cell-empty">-</td>}
        {!compact && <td className="mono entry-cell-empty">-</td>}
        <td className="entry-cell-actions">
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
  const { file, connectionId, bucket, allTags, tagIds, onTagsChange, compact, selected } = props
  const entry = useFileEntryActions(props)
  const size = fmtSize(file.size)
  const modified = file.lastModified?.slice(0, 10) ?? ''
  return (
    <>
      {/* 行全体がボタン (押す・Enter・Space でプレビュー)。 */}
      <tr
        className={selected ? 'entry-row-file selected' : 'entry-row-file'}
        role="button"
        tabIndex={0}
        aria-current={selected ? 'true' : undefined}
        onClick={entry.select}
        onKeyDown={entry.onKeyDown}
      >
        <td>
          <EntryLabel kind="file" tail={entry.tail} tags={entry.tags} fileKey={file.key} />
          {compact && (
            <div className="entry-meta">
              {size}{modified && ` · ${modified}`}
            </div>
          )}
        </td>
        {!compact && <td className="numeric mono">{size}</td>}
        {!compact && <td className="mono">{modified}</td>}
        <td className="entry-cell-actions">
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

interface Props {
  dirs: string[]
  files: StorageFileEntry[]
  prefix: string
  connectionId: string
  bucket: string
  onSelectFile?: (key: string) => void
  /** プレビューで開いているファイルのキー。その行を選択中にする。 */
  selectedKey?: string | null
  allTags?: Tag[]
  /** タグ機能の全体トグル (Settings → 機能)。false ならタグ関連の導線を出さない。 */
  tagsEnabled?: boolean
  tagsByPath?: Record<string, string[]>
  onTagsChange?: (path: string, tagIds: string[]) => void
}

export function EntryTable({
  dirs, files, prefix, connectionId, bucket, onSelectFile, selectedKey = null,
  allTags = [], tagsByPath = {}, onTagsChange, tagsEnabled = true,
}: Props) {
  const compact = useIsCompact()
  const shared = { prefix, connectionId, bucket, allTags, onTagsChange, tagsEnabled, compact }
  return (
    <div className={compact ? 'table-scroll entry-table compact' : 'table-scroll entry-table'}>
      <table>
        <thead>
          <tr>
            <th scope="col">Name</th>
            {!compact && <th scope="col" className="numeric entry-col-size">Size</th>}
            {!compact && <th scope="col" className="entry-col-modified">Modified</th>}
            <th scope="col" className="entry-col-actions"><span className="sr-only">操作</span></th>
          </tr>
        </thead>
        <tbody>
          {dirs.map(d => (
            <DirectoryRow key={d} directory={d} tagIds={tagsByPath[d] ?? []} {...shared} />
          ))}
          {files.map(f => (
            <FileRow
              key={f.key}
              file={f}
              tagIds={tagsByPath[f.key] ?? []}
              selected={f.key === selectedKey}
              onSelectFile={onSelectFile}
              {...shared}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}
