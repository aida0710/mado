import { useCallback } from 'react'
import { api } from '../lib/api/client'
import { HistoryModal } from './HistoryModal'

interface Props {
  slug: string
  // 現在の本文 (一致版を強調表示)。null = 現在 note なし。
  currentBody: string | null
  onClose: () => void
}

// Team note (postgres notes テーブル) の編集履歴モーダル。
// 取得元と見出しだけがここの責務で、表示は HistoryModal と共通。
export function NoteHistoryModal({ slug, currentBody, onClose }: Props) {
  const loadVersions = useCallback(() => api.noteHistory(slug).then(r => r.versions), [slug])
  const loadVersion = useCallback((id: number) => api.noteHistoryVersion(slug, id), [slug])
  return (
    <HistoryModal
      kicker="Team note · 履歴"
      titleId="note-history-title"
      title={slug}
      currentBody={currentBody}
      onClose={onClose}
      loadVersions={loadVersions}
      loadVersion={loadVersion}
    />
  )
}
