import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api/client'
import type { Tag, TargetKind } from '../lib/api/types'
import { TagBadge } from './TagBadge'

interface Props {
  connId: string
  bucket: string
  kind: TargetKind
  path: string
  label: string
  allTags: Tag[]
  assignedTagIds: string[]
  onChange: (nextAssignedTagIds: string[]) => void
  onClose: () => void
}

// 対象 1 件 (bucket/prefix/file) へのタグ割り当てを編集するモーダル。
// 新規タグの作成はここではできない (Settings の TagsSettings のみ) —
// 一覧作業中に語彙が無秩序に増えるのを防ぐため。
export function TagPicker({
  connId, bucket, kind, path, label, allTags, assignedTagIds, onChange, onClose,
}: Props) {
  const [assigned, setAssigned] = useState<Set<string>>(new Set(assignedTagIds))
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const toggle = async (tag: Tag) => {
    const wasAssigned = assigned.has(tag.id)
    setError(null)
    setBusyId(tag.id)
    const next = new Set(assigned)
    if (wasAssigned) next.delete(tag.id); else next.add(tag.id)
    setAssigned(next)
    try {
      if (wasAssigned) await api.unassignTag(connId, bucket, kind, path, tag.id)
      else await api.assignTag(connId, bucket, kind, path, tag.id)
      onChange([...next])
    } catch (e) {
      // 失敗時はチェック状態を戻す (楽観更新のロールバック)。
      setAssigned(assigned)
      setError((e as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="modal-backdrop">
      <div
        className="modal modal--narrow"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tag-picker-title"
      >
        <p className="kicker">タグ</p>
        <h3 id="tag-picker-title">{label}</h3>

        {allTags.length === 0 ? (
          <p className="text-[13px] text-ink-7">
            タグがまだありません。<Link to="/connections">Settings</Link> で作成してください。
          </p>
        ) : (
          <ul className="m-0 list-none p-0">
            {allTags.map(tag => (
              <li key={tag.id} className="flex items-center gap-3 py-2">
                <label className="flex flex-1 items-center gap-2 text-[13px]">
                  <input
                    type="checkbox"
                    aria-label={tag.name}
                    checked={assigned.has(tag.id)}
                    disabled={busyId === tag.id}
                    onChange={() => toggle(tag)}
                  />
                  <TagBadge tag={tag} />
                </label>
              </li>
            ))}
          </ul>
        )}

        {error && <p className="error" aria-live="polite">{error}</p>}
        <div className="modal-actions">
          <button onClick={onClose}>閉じる</button>
        </div>
      </div>
    </div>
  )
}
