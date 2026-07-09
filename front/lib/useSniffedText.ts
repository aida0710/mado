import { useEffect, useState } from 'react'
import { api } from './api/client'
import { looksBinary, TEXT_HEAD_BYTES } from './textSniff'

export type SniffedText =
  | { status: 'loading' }
  | { status: 'text'; text: string }
  | { status: 'binary' }
  | { status: 'error'; message: string }

// プレビュー対象の先頭を取得し、テキストかバイナリかを決める。url は
// api.textPreviewUrl() か api.tarEntryUrl() の戻り値。
//
// url 変化時の loading への差し戻しはしない — 呼び出し側は key で再マウントする
// 流儀 (PreviewDrawer / TarEntryModal / PinnedPreviewCard)。effect 内で同期 setState
// すると react-hooks/set-state-in-effect に引っかかるので、そこは避ける。
export function useSniffedText(url: string): SniffedText {
  const [state, setState] = useState<SniffedText>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    api.readHead(url, TEXT_HEAD_BYTES)
      .then(head => {
        if (cancelled) return
        // fatal なしの不可逆デコード。64KB 境界で割れたマルチバイト文字は
        // U+FFFD 1 個で済み、非 UTF-8 のテキストも従来どおり文字化けして表示される。
        setState(looksBinary(head)
          ? { status: 'binary' }
          : { status: 'text', text: new TextDecoder().decode(head) })
      })
      .catch((e: Error) => {
        if (!cancelled) setState({ status: 'error', message: e.message })
      })
    return () => { cancelled = true }
  }, [url])

  return state
}
