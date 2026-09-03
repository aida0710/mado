import { useEffect, useState } from 'react'

export interface MediaSrcState {
  src: string | null
  loading: boolean
  error: string | null
}

// 単体mediaはRange対応のAPI URLをそのまま返し、tar内エントリは一度だけ取得して
// blob URL化する。tar-entry APIはRange非対応なので、blob化しないとaudio/videoの
// 未buffer位置へのseekが安定しない。
export function useMediaSrc(
  directUrl: string | null,
  archiveEntryUrl: string | null,
): MediaSrcState {
  const [archive, setArchive] = useState<MediaSrcState>(() =>
    archiveEntryUrl
      ? { src: null, loading: true, error: null }
      : { src: null, loading: false, error: null },
  )

  // archiveEntryUrlの変更は呼び出し側がkeyで再mountする前提。ここでは取得・解放だけを
  // 担当し、effect内の同期setStateによる余分な再renderは避ける。
  useEffect(() => {
    if (!archiveEntryUrl) return
    let objectUrl: string | null = null
    const ctl = new AbortController()
    fetch(archiveEntryUrl, { signal: ctl.signal })
      .then(async res => {
        if (!res.ok) {
          let msg = res.statusText
          try {
            const body = (await res.json()) as { error?: string }
            if (body.error) msg = body.error
          } catch { /* statusTextをそのまま使う */ }
          throw new Error(msg)
        }
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
  }, [archiveEntryUrl])

  if (directUrl) return { src: directUrl, loading: false, error: null }
  return archive
}
