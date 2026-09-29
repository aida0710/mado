import { useCallback, useEffect, useState } from 'react'
import { failedLoad, LOADING, type LoadState } from './loadState'

/**
 * load() の結果を LoadState で返し、retry() で取り直せるようにする。
 * load が変わったときと retry() のときに取り直す。load は useCallback か
 * モジュールの関数で固定して渡す。null の間は取得しない（権限が無いときなど）。
 */
export function useRetryableLoad<T>(load: (() => Promise<T>) | null): { state: LoadState<T>; retry: () => void } {
  const [attempt, setAttempt] = useState(0)
  // 結果は「どの load の何回目の取得か」と一緒に持つ。load や attempt が変わった
  // 瞬間に描画側が loading に戻り、前の結果が見え続けない。effect 内で同期的に
  // loading へ戻す手もあるが、それは react-hooks/set-state-in-effect に引っかかる。
  const [settled, setSettled] = useState<{
    load: () => Promise<T>
    attempt: number
    state: LoadState<T>
  } | null>(null)

  useEffect(() => {
    if (!load) return
    let cancelled = false
    load().then(
      value => { if (!cancelled) setSettled({ load, attempt, state: { status: 'loaded', value } }) },
      (error: unknown) => { if (!cancelled) setSettled({ load, attempt, state: failedLoad(error) }) },
    )
    return () => { cancelled = true }
  }, [load, attempt])

  const retry = useCallback(() => setAttempt(current => current + 1), [])
  const isCurrent = settled !== null && settled.load === load && settled.attempt === attempt
  return { state: isCurrent ? settled.state : LOADING, retry }
}
