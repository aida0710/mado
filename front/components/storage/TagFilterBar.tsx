import type { Tag } from '../../lib/api/types'
import { TagToggleChips } from '../TagToggleChips'

interface Props {
  tags: Tag[]              // 今表示中の行に実際に出現する候補タグのみ
  selected: Set<string>
  onToggle: (tagId: string) => void
  onClear: () => void
}

// 一覧上部の絞り込みチップ。選んだタグのいずれかを含む行だけに絞る (OR)。
// クライアント側フィルタ — 取得済みの一覧データに対して行う。
export function TagFilterBar({ tags, selected, onToggle, onClear }: Props) {
  if (tags.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-2 py-2">
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.22em] text-ink-7">
        タグで絞り込み
      </span>
      <TagToggleChips tags={tags} selected={selected} onToggle={onToggle} onClear={onClear} />
    </div>
  )
}
