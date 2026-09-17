import { useCallback, useMemo, useState, type KeyboardEvent } from 'react'
import { api } from '../../lib/api/client'
import { classify } from '../../lib/api/mime'
import type { StorageFileEntry, Tag } from '../../lib/api/types'
import { absoluteUrl, encPath } from '../../lib/route'
import { usePlayerDeck } from '../../lib/playerDeck'
import { usePinnedPreviews } from '../../lib/pinnedPreviews'
import { useCapabilities } from '../../lib/useCapabilities'
import type { MenuItem } from '../CopyMenu'

// 一覧の行 (table) とカード (phone) は見た目だけが違い、URL・メニュー・タグ・
// 選択の扱いは同じ。ここに寄せて、描画側は tr / li の組み立てだけにする。

export interface EntryTagProps {
  allTags: Tag[]
  tagIds: string[]
  /** タグ機能の全体トグル (Settings → 機能)。false ならタグ関連の導線を出さない。 */
  tagsEnabled: boolean
}

interface DirectoryEntryInput extends EntryTagProps {
  directory: string
  prefix: string
  connectionId: string
  bucket: string
}

/** 表示は現ディレクトリ基準で末尾を切る。検索中は effectivePrefix が
 *  `prefix + q` だが、入っているキーは prefix で始まるのでそのまま slice。 */
function tailOf(key: string, prefix: string): string {
  return key.startsWith(prefix) ? key.slice(prefix.length) : key
}

function assignedTags({ allTags, tagIds, tagsEnabled }: EntryTagProps): Tag[] {
  return tagsEnabled ? allTags.filter(t => tagIds.includes(t.id)) : []
}

export function useDirectoryEntryActions({
  directory, prefix, connectionId, bucket, allTags, tagIds, tagsEnabled,
}: DirectoryEntryInput) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const href = `/storage/${encodeURIComponent(connectionId)}/${encodeURIComponent(bucket)}/${encPath(directory)}`
  const s3Url = `s3://${bucket}/${directory}`
  const webUrl = absoluteUrl(href)
  const items = useMemo<MenuItem[]>(() => [
    { kind: 'copy', label: 'Web URL をコピー', value: webUrl },
    { kind: 'copy', label: 'S3 URL をコピー', value: s3Url },
    ...(tagsEnabled
      ? [{ kind: 'action' as const, label: 'タグを編集', onSelect: () => setPickerOpen(true) }]
      : []),
  ], [webUrl, s3Url, tagsEnabled])
  return {
    tail: tailOf(directory, prefix),
    href,
    tags: assignedTags({ allTags, tagIds, tagsEnabled }),
    items,
    pickerOpen,
    setPickerOpen,
  }
}

interface FileEntryInput extends EntryTagProps {
  file: StorageFileEntry
  prefix: string
  connectionId: string
  bucket: string
  onSelectFile?: (key: string) => void
}

export function useFileEntryActions({
  file, prefix, connectionId, bucket, onSelectFile, allTags, tagIds, tagsEnabled,
}: FileEntryInput) {
  const deck = usePlayerDeck()
  const pinned = usePinnedPreviews()
  const [pickerOpen, setPickerOpen] = useState(false)
  const select = useCallback(() => onSelectFile?.(file.key), [onSelectFile, file.key])
  // Enter / Space で preview を開く。dir 行は <Link> がネイティブで処理する。
  const onKeyDown = useCallback((e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      select()
    }
  }, [select])
  // Web URL は dashboard origin + 現在ナビゲーション + ?preview=<key>。
  // 別ユーザに送ると「直リンクで preview drawer が開く」共有 URL になる。
  const webUrl = absoluteUrl(
    `/storage/${encodeURIComponent(connectionId)}/${encodeURIComponent(bucket)}/${encPath(prefix)}`
    + `?preview=${encodeURIComponent(file.key)}`,
  )
  const s3Url = `s3://${bucket}/${file.key}`
  const downloadUrl = api.downloadUrl(connectionId, bucket, file.key)
  const filename = file.key.split('/').pop() ?? 'file'
  const isAudio = classify(file.key) === 'audio'
  const capabilities = useCapabilities(connectionId)
  const items = useMemo<MenuItem[]>(() => [
    // デッキ (同期再生) は音声本体を読むので preview 権限が要る。
    ...(isAudio && capabilities.preview ? [{
      kind: 'action' as const,
      label: 'デッキに追加',
      onSelect: () => deck.addTrack({
        label: filename, connectionId, bucket, key: file.key,
      }),
    }] : []),
    // 種別で出し分けない。中身を見るまでテキストかどうか分からないので、
    // 拡張子でゲートすると「ドロワーでは開けるのにピン留めできない」不揃いが残る。
    // バイナリをピンしてもカードに「プレビュー非対応」と出るだけで実害はない。
    {
      kind: 'action' as const,
      label: 'ピン留め',
      onSelect: () => pinned.addPin({ connectionId, bucket, key: file.key }),
    },
    ...(tagsEnabled
      ? [{ kind: 'action' as const, label: 'タグを編集', onSelect: () => setPickerOpen(true) }]
      : []),
    ...(capabilities.download
      ? [{ kind: 'download' as const, label: 'このファイルをダウンロード', href: downloadUrl, filename }]
      : []),
    { kind: 'copy',     label: 'Web URL をコピー',           value: webUrl },
    { kind: 'copy',     label: 'S3 URL をコピー',            value: s3Url },
  ], [
    isAudio, capabilities.preview, capabilities.download, tagsEnabled, deck, pinned,
    connectionId, bucket, file.key, downloadUrl, webUrl, s3Url, filename,
  ])
  return {
    tail: tailOf(file.key, prefix),
    tags: assignedTags({ allTags, tagIds, tagsEnabled }),
    items,
    select,
    onKeyDown,
    pickerOpen,
    setPickerOpen,
  }
}
