import { useCallback, useSyncExternalStore } from 'react'

/**
 * メディアクエリが一致しているか。画面幅が変わるたびに描き直す。
 * matchMedia が無い環境 (サーバー描画) では false を返し、広い画面の形を既定にする。
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
      const list = window.matchMedia(query)
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    [query],
  )
  return useSyncExternalStore(
    subscribe,
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
    () => false,
  )
}
