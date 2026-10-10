import { Check } from 'lucide-react'
import type { Tag } from '../lib/api/types'
import { TagColorDot } from './TagBadge'

interface Props {
  tags: Tag[]
  selected: Set<string>
  onToggle: (tagId: string) => void
  onClear: () => void
}

/** タグを押して選択の on / off を切り替えるボタン群。何か選んでいればクリアも出す。
 *  一覧の絞り込みとタグ検索で同じ見た目にする。選択中は地と枠をアクセントの色にし、
 *  色だけに頼らないようチェックの印も付ける。 */
export function TagToggleChips({ tags, selected, onToggle, onClear }: Props) {
  return (
    <>
      {tags.map(tag => {
        const pressed = selected.has(tag.id)
        return (
          <button
            key={tag.id}
            type="button"
            className="tag-chip"
            onClick={() => onToggle(tag.id)}
            aria-pressed={pressed}
          >
            <TagColorDot color={tag.color} />
            {tag.name}
            {pressed && <Check size={12} aria-hidden="true" />}
          </button>
        )
      })}
      {selected.size > 0 && (
        <button type="button" className="button small" onClick={onClear}>クリア</button>
      )}
    </>
  )
}
