import { useEffect, useState } from 'react'
import { errorFromResponse, fetchApi } from './api/http'

export interface MediaSrcState {
  src: string | null
  loading: boolean
  error: string | null
}

// 単体ファイルと非圧縮tarはRange対応のURLを直接再生する。
// 順次解凍が必要な圧縮tarは一度取得してBlobにし、ブラウザ内でシークする。
export function useMediaSrc({ directUrl, archiveEntryUrl, archiveKey }: {
  directUrl: string | null
  archiveEntryUrl: string | null
  archiveKey?: string
}): MediaSrcState {
  const streamingUrl = directUrl ?? (archiveKey?.toLowerCase().endsWith('.tar') ? archiveEntryUrl : null)
  const [archive, setArchive] = useState<MediaSrcState>(() =>
    archiveEntryUrl && !streamingUrl
      ? { src: null, loading: true, error: null }
      : { src: null, loading: false, error: null },
  )

  // archiveEntryUrlの変更は呼び出し側がkeyで再mountする前提。ここでは取得・解放だけを
  // 担当し、effect内の同期setStateによる余分な再renderは避ける。
  useEffect(() => {
    if (!archiveEntryUrl || streamingUrl) return
    let objectUrl: string | null = null
    const ctl = new AbortController()
    fetchApi(archiveEntryUrl, { signal: ctl.signal })
      .then(async res => {
        if (!res.ok) throw await errorFromResponse(res)
        return res.blob()
      })
      .then(blob => {
        objectUrl = URL.createObjectURL(blob)
        setArchive({ src: objectUrl, loading: false, error: null })
      })
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) {
          setArchive({ src: null, loading: false, error: (e as Error).message })
        }
      })
    return () => {
      ctl.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [archiveEntryUrl, streamingUrl])

  if (streamingUrl) return { src: streamingUrl, loading: false, error: null }
  return archive
}
