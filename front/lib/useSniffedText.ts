import { useEffect, useState } from 'react'
import { api } from './api/client'
import { looksBinary, TEXT_HEAD_BYTES } from './textSniff'

export type SniffedText =
  | { status: 'loading' }
  | { status: 'text'; text: string }
  | { status: 'binary' }
  | { status: 'error'; message: string }

// loading は毎回同じ参照を返す。新しいオブジェクトを返すと、消費側がこの戻り値を
// 依存配列に入れたときに無関係な再描画のたびに再発火する踏み台になる。
const LOADING: SniffedText = { status: 'loading' }

// プレビュー対象の先頭を取得し、テキストかバイナリかを決める。url は
// api.textPreviewUrl() か api.tarEntryUrl() の戻り値。
export function useSniffedText(url: string): SniffedText {
  // 取得結果は「どの url のものか」と一緒に持つ。こうすると url が変わった瞬間に
  // 描画側が loading に戻り、前のファイルの本文が一瞬見える事故が起きない。
  // effect 内で同期 setState して loading に戻す手もあるが、それは
  // react-hooks/set-state-in-effect に引っかかる。
  const [result, setResult] = useState<{ url: string; value: SniffedText } | null>(null)

  useEffect(() => {
    let cancelled = false
    api.readHead(url, TEXT_HEAD_BYTES)
      .then(head => {
        if (cancelled) return
        // fatal なしの不可逆デコード。64KB 境界で割れたマルチバイト文字は
        // U+FFFD 1 個で済み、非 UTF-8 のテキストも従来どおり文字化けして表示される。
        setResult({
          url,
          value: looksBinary(head)
            ? { status: 'binary' }
            : { status: 'text', text: new TextDecoder().decode(head) },
        })
      })
      .catch((e: unknown) => {
        if (!cancelled) setResult({ url, value: { status: 'error', message: (e as Error).message } })
      })
    return () => { cancelled = true }
  }, [url])

  return result?.url === url ? result.value : LOADING
}
