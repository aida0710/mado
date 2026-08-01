import { useEffect, useReducer } from 'react'
import { api } from './api/client'

// 機能の全体トグル (Settings → 機能)。接続ごとの権限 (useCapabilities) とは別物で、
// こちらは「Mado 全体でその機能を出すか」だけを決める表示上の設定。
//
// 既定は true。マイグレーションの初期値と揃えてあるので、通常はタブが
// 一瞬消えてから出る、という挙動にならない。オフにしている場合だけ、
// 設定が届いた時点で消える。
//
// キャッシュは持たない。Settings で切り替えた結果が次の画面遷移で
// すぐ反映されてほしいため (リクエストは設定表 1 行の取得のみ)。
//
// useState のセッターを useEffect 内で直接呼ぶと react-hooks/set-state-in-effect
// (eslint) に引っかかるので useReducer + dispatch で持つ。
function useFeatureEnabled(key: 'lineage_enabled' | 'tags_enabled'): boolean {
  const [enabled, dispatch] = useReducer((_: boolean, next: boolean) => next, true)

  useEffect(() => {
    let cancelled = false
    api.settings()
      .then(s => { if (!cancelled) dispatch(s[key] !== 'false') })
      // 取得失敗時は既定 (true) のまま。設定 API が落ちても既存機能は使える。
      .catch(() => {})
    return () => { cancelled = true }
  }, [key])

  return enabled
}

/** 家系図タブを出すか。 */
export function useLineageEnabled(): boolean {
  return useFeatureEnabled('lineage_enabled')
}

/** タグ関連の導線 (バッジ / 絞り込み / タグ検索 / Settings のタグ管理) を出すか。 */
export function useTagsEnabled(): boolean {
  return useFeatureEnabled('tags_enabled')
}
