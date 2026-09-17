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

/** 一覧の 1 エントリに対するタグ編集モーダル。open のときだけ描く。
 *  onTagsChange には「どのエントリの」タグかを path 付きで返す。 */
export function EntryTagPicker({
  open, onClose, connectionId, bucket, kind, path, label, allTags, tagIds, onTagsChange,
}: Props) {
  if (!open) return null
  return (
    <TagPicker
      connectionId={connectionId} bucket={bucket} kind={kind} path={path} label={label}
      allTags={allTags} assignedTagIds={tagIds}
      onChange={next => onTagsChange?.(path, next)}
      onClose={onClose}
    />
  )
}
