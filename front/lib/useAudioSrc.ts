import { useEffect, useState } from 'react'
import { api } from './api/client'

export interface AudioSrcState {
  src: string | null // 再生可能になったら non-null (単体ファイルは即、tar 内エントリは blob 取得後)
  loading: boolean // tar エントリの blob 取得中のみ true
  error: string | null
}

interface BlobState {
  src: string | null
  loading: boolean
  error: string | null
}

// 音声の再生 src を解決する。単体ファイルはストリーミング URL をそのまま、
// tar 内エントリは blob 化する。
//
// `/storage/:connId/preview/tar-entry` は Range リクエストを無視して常に 200 で
// 全量を返す (Accept-Ranges なし)。Chrome などのメディア要素は Range 非対応の
// ソースだとバッファ済み範囲にしかシークできず、未バッファ位置へのシークは
// 現在の再生位置へ巻き戻る。tar.xz はサーバー側抽出に 100 秒超かかることも
// あり、その間ほぼ全域が未バッファなためシークバー操作が実質使えなくなる。
// fetch で一度取得 (= 抽出は 1 回だけ) して blob URL 化すれば、以降のシークは
// 完全ローカルになりこの制約を受けない。
export function useAudioSrc(
  connId: string,
  bucket: string,
  k: string,
  entryPath?: string,
): AudioSrcState {
  // tar 側の内部状態のみ state で持つ。単体ファイルの src は props から毎回
  // 導出できる純粋な値なので state に持たず、下の return で直接計算する —
  // そうすることで props 変化時 (同一マウント内) にも常に最新の値になり、
  // かつ effect 内で同期 setState する必要がなくなる (react-hooks/set-state-in-effect
  // が検出するカスケード再レンダーを避けられる)。
  const [tar, setTar] = useState<BlobState>(() =>
    entryPath ? { src: null, loading: true, error: null } : { src: null, loading: false, error: null },
  )

  // tar → 別 tar エントリへの props 変化 (remount なし) は、呼び出し側が key で
  // 再マウントする前提のため意図的に未対応 (PreviewAudio の mediaAnalyze と同じ
  // 方針)。ここでの分岐は「tar かどうか」の防御のみに使う。
  useEffect(() => {
    if (!entryPath) return
    let objectUrl: string | null = null
    const ctl = new AbortController()
    fetch(api.tarEntryUrl(connId, bucket, k, entryPath), { signal: ctl.signal })
      .then(async res => {
        if (!res.ok) {
          let msg = res.statusText
          try {
            const body = (await res.json()) as { error?: string }
            if (body.error) msg = body.error
          } catch { /* statusText をそのまま使う */ }
          throw new Error(msg)
        }
        return res.blob()
      })
      .then(blob => {
        objectUrl = URL.createObjectURL(blob)
        setTar({ src: objectUrl, loading: false, error: null })
      })
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setTar({ src: null, loading: false, error: (e as Error).message })
      })
    return () => {
      ctl.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [connId, bucket, k, entryPath])

  if (!entryPath) return { src: api.audioUrl(connId, bucket, k), loading: false, error: null }
  return tar
}
