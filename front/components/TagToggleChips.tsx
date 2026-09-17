import type { Tag } from '../lib/api/types'
import { TagBadge } from './TagBadge'

interface Props {
  tags: Tag[]
  selected: Set<string>
  onToggle: (tagId: string) => void
  onClear: () => void
}

/** タグを押して選択の on / off を切り替えるチップ群。何か選んでいればクリアも出す。
 *  一覧の絞り込みとタグ検索で同じ見た目にする。 */
export function TagToggleChips({ tags, selected, onToggle, onClear }: Props) {
  return (
    <>
      {tags.map(tag => (
        <button
          key={tag.id}
          type="button"
          onClick={() => onToggle(tag.id)}
          className="cursor-pointer border-0 bg-transparent p-0"
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
    </>
  )
}
