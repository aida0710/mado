import { useEffect } from 'react'

/** Escape キーで onClose を呼ぶ。モーダル類で共通。
 *  onClose が毎レンダーで変わると listener を張り直すだけで、動作は変わらない。 */
export function useEscapeToClose(onClose: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
}
