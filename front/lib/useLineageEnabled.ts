import { useEffect, useReducer } from 'react'
import { api } from './api/client'

// 家系図タブを出すかどうか (Settings → 機能)。
//
// 既定は true。マイグレーションの初期値と揃えてあるので、通常はタブが
// 一瞬消えてから出る、という挙動にならない。オフにしている場合だけ、
// 設定が届いた時点でタブが消える。
//
// キャッシュは持たない。Settings で切り替えた結果が次の画面遷移で
// すぐ反映されてほしいため (リクエストは設定表 1 行の取得のみ)。
//
// useState のセッターを useEffect 内で直接呼ぶと react-hooks/set-state-in-effect
// (eslint) に引っかかるので useReducer + dispatch で持つ。
export function useLineageEnabled(): boolean {
  const [enabled, dispatch] = useReducer((_: boolean, next: boolean) => next, true)

  useEffect(() => {
    let cancelled = false
    api.settings()
      .then(s => { if (!cancelled) dispatch(s.lineage_enabled !== 'false') })
      // 取得失敗時は既定 (true) のまま。設定 API が落ちても既存機能は使える。
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  return enabled
}
