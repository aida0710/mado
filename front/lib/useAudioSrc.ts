import { api } from './api/client'
import { useMediaSrc, type MediaSrcState } from './useMediaSrc'

export type AudioSrcState = MediaSrcState

// 音声も動画と同じ経路で、単体ファイルと非圧縮tarを部分取得する。
export function useAudioSrc({ connectionId, bucket, key, entryPath }: {
  connectionId: string
  bucket: string
  key: string
  /** tar 内のエントリなら、その tar 内パス。 */
  entryPath?: string
}): AudioSrcState {
  const directUrl = entryPath ? null : api.audioUrl(connectionId, bucket, key)
  const archiveEntryUrl = entryPath ? api.tarEntryUrl({ connectionId, bucket, key, entry: entryPath }) : null
  return useMediaSrc({ directUrl, archiveEntryUrl, archiveKey: key })
}
