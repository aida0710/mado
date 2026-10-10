import { createPortal } from 'react-dom'
import type { Tag, TargetKind } from '../../lib/api/types'
import { TagPicker } from '../TagPicker'

interface Props {
  open: boolean
  onClose: () => void
  connectionId: string
  bucket: string
  kind: Extract<TargetKind, 'prefix' | 'file'>
  path: string
  label: string
  allTags: Tag[]
  tagIds: string[]
  onTagsChange?: (path: string, tagIds: string[]) => void
}

/** 一覧の 1 エントリに対するタグ編集ダイアログ。open のときだけ描く。
 *  onTagsChange には「どのエントリの」タグかを path 付きで返す。
 *
 *  表の行 (<tr>) の隣に置かれるので、<tbody> の中に <div> を作らないよう body へ出す。
 *  行の子にはしない — React のイベントは描画した場所を遡るので、ダイアログの中の
 *  クリックや Enter が行のプレビューを開く操作へ伝わってしまう。 */
export function EntryTagPicker({
  open, onClose, connectionId, bucket, kind, path, label, allTags, tagIds, onTagsChange,
}: Props) {
  if (!open) return null
  return createPortal(
    <TagPicker
      connectionId={connectionId} bucket={bucket} kind={kind} path={path} label={label}
      allTags={allTags} assignedTagIds={tagIds}
      onChange={next => onTagsChange?.(path, next)}
      onClose={onClose}
    />,
    document.body,
  )
}
