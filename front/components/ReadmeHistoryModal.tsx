import { useCallback } from 'react'
import { api } from '../lib/api/client'
import { HistoryModal } from './HistoryModal'

interface Props {
  connectionId: string
  bucket: string
  prefix: string
  // README が現在も S3 に存在するなら現在の本文を渡す。履歴と並べて diff 風に
  // 比較するヒントとして使う (今は単純に "現在" マーカーとして表示)。
  currentBody: string | null
  onClose: () => void
}

// S3 README の編集履歴ダイアログ。
// 取得元と見出しだけがここの責務で、表示は HistoryModal と共通。
export function ReadmeHistoryModal({ connectionId, bucket, prefix, currentBody, onClose }: Props) {
  const loadVersions = useCallback(
    () => api.readmeHistory({ connectionId, bucket, prefix }).then(r => r.versions),
    [connectionId, bucket, prefix],
  )
  const loadVersion = useCallback(
    (id: number) => api.readmeHistoryVersion(connectionId, id),
    [connectionId],
  )
  return (
    <HistoryModal
      title="README の履歴"
      titleId="readme-history-title"
      subtitle={`${bucket} / ${prefix || '(root)'}`}
      currentBody={currentBody}
      onClose={onClose}
      loadVersions={loadVersions}
      loadVersion={loadVersion}
    />
  )
}
