import { useSyncExternalStore } from 'react'

// <sm (= 640px 未満、phones) を compact とする。
// CSS の `hidden sm:block` で両方を DOM に置くと jsdom + Testing Library が
// 同じ key の要素を複数ヒットしてしまうので、matchMedia を購読して片方だけ
// 描画する。SSR / 初期描画は desktop 既定 (matches=false) として扱う。
const COMPACT_QUERY = '(max-width: 639.98px)'

const getCompactSnapshot = (): boolean =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(COMPACT_QUERY).matches
    : false

const subscribeCompact = (onStoreChange: () => void): (() => void) => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
  const mql = window.matchMedia(COMPACT_QUERY)
  mql.addEventListener('change', onStoreChange)
  return () => mql.removeEventListener('change', onStoreChange)
}

/** phone 幅なら true。table と card list の切替に使う。 */
export function useIsCompact(): boolean {
  return useSyncExternalStore(subscribeCompact, getCompactSnapshot, () => false)
}
