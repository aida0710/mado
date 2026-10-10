import { useId, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api/client'
import type { Tag, TargetKind } from '../lib/api/types'
import { Dialog } from './Dialog'
import { TagBadge } from './TagBadge'

interface Props {
  connectionId: string
  bucket: string
  kind: TargetKind
  path: string
  label: string
  allTags: Tag[]
  assignedTagIds: string[]
  onChange: (nextAssignedTagIds: string[]) => void
  onClose: () => void
}

// 対象 1 件 (bucket/prefix/file) へのタグ割り当てを編集するダイアログ。
// チェックを切り替えるたびにその場で保存するので、下のボタンは「閉じる」だけ。
// 新規タグの作成はここではできない (Settings の TagsSettings のみ) —
// 一覧作業中に語彙が無秩序に増えるのを防ぐため。
export function TagPicker({
  connectionId, bucket, kind, path, label, allTags, assignedTagIds, onChange, onClose,
}: Props) {
  const titleId = useId()
  const [assigned, setAssigned] = useState<Set<string>>(new Set(assignedTagIds))
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const toggle = async (tag: Tag) => {
    const wasAssigned = assigned.has(tag.id)
    setError(null)
    setBusyId(tag.id)
    // 楽観更新。他のタグの操作が並行して進行中でも壊れないよう、
    // 常に最新の状態 (prev) を起点に自分自身のタグだけを変更する。
    // このトグル自身が確定させる結果を settled に控えておき、成功時に
    // そのまま onChange へ渡す (outer の assigned は以降一切読まない)。
    let settled: string[] = []
    setAssigned(prev => {
      const next = new Set(prev)
      if (wasAssigned) next.delete(tag.id); else next.add(tag.id)
      settled = [...next]
      return next
    })
    try {
      const target = { connectionId, bucket, kind, path, tagId: tag.id }
      if (wasAssigned) await api.unassignTag(target)
      else await api.assignTag(target)
      onChange(settled)
    } catch (e) {
      // 失敗時はチェック状態を戻す (楽観更新のロールバック)。
      // outer の assigned は参照せず、最新状態 (prev) に対して
      // 自分自身のタグの変更だけを打ち消す。
      setAssigned(prev => {
        const rolledBack = new Set(prev)
        if (wasAssigned) rolledBack.add(tag.id); else rolledBack.delete(tag.id)
        return rolledBack
      })
      setError((e as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Dialog
      titleId={titleId}
      title="タグを編集"
      subtitle={label}
      onClose={onClose}
      // 下の「閉じる」ボタンと読み上げの名前が重ならないよう、×と背景には別の名前を付ける。
      closeLabel="タグの編集を閉じる"
      narrowLayout="sheet"
      footer={<button type="button" className="button" onClick={onClose}>閉じる</button>}
    >
      <div className="dialog-body">
        {allTags.length === 0 ? (
          <p className="muted">
            タグがまだありません。<Link to="/settings/features">Settings</Link> で作成してください。
          </p>
        ) : (
          <ul className="tag-picker-list">
            {allTags.map(tag => (
              <li key={tag.id}>
                <label className="checkbox-field">
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

        {error && <p className="notice error" aria-live="polite">{error}</p>}
      </div>
    </Dialog>
  )
}
