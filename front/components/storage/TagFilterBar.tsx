import type { Tag } from '../../lib/api/types'
import { TagBadge } from '../TagBadge'

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
      {tags.map(tag => (
        <button
          key={tag.id}
          type="button"
          onClick={() => onToggle(tag.id)}
          className="border-0 bg-transparent p-0 cursor-pointer"
          // 未選択は淡くするが 0.4 だと薄い。バッジ自体が淡いティントに
          // なったので、それより薄くすると読めなくなる。
          style={{ opacity: selected.size === 0 || selected.has(tag.id) ? 1 : 0.55 }}
          aria-pressed={selected.has(tag.id)}
        >
          <TagBadge tag={tag} />
        </button>
      ))}
      {selected.size > 0 && (
        <button type="button" className="ghost" onClick={onClear}>クリア</button>
      )}
    </div>
  )
}
