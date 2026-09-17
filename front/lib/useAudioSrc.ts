import { api } from './api/client'
import { useMediaSrc, type MediaSrcState } from './useMediaSrc'

export type AudioSrcState = MediaSrcState

// 音声の再生 src を解決する。単体ファイルはストリーミング URL をそのまま、
// tar 内エントリは blob 化する。
//
// `/storage/:connectionId/preview/tar-entry` は Range リクエストを無視して常に 200 で
// 全量を返す (Accept-Ranges なし)。Chrome などのメディア要素は Range 非対応の
// ソースだとバッファ済み範囲にしかシークできず、未バッファ位置へのシークは
// 現在の再生位置へ巻き戻る。tar.xz はサーバー側抽出に 100 秒超かかることも
// あり、その間ほぼ全域が未バッファなためシークバー操作が実質使えなくなる。
// fetch で一度取得 (= 抽出は 1 回だけ) して blob URL 化すれば、以降のシークは
// 完全ローカルになりこの制約を受けない。
export function useAudioSrc({ connectionId, bucket, key, entryPath }: {
  connectionId: string
  bucket: string
  key: string
  /** tar 内のエントリなら、その tar 内パス。 */
  entryPath?: string
}): AudioSrcState {
  const directUrl = entryPath ? null : api.audioUrl(connectionId, bucket, key)
  const archiveEntryUrl = entryPath ? api.tarEntryUrl(connectionId, bucket, key, entryPath) : null
  return useMediaSrc(directUrl, archiveEntryUrl)
}
