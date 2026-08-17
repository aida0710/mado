import { useEffect, useReducer } from 'react'
import { api } from '../lib/api/client'

const sectionTitleClass =
  'm-0 text-[10.5px] font-semibold uppercase tracking-[0.22em] text-ink-7'

// 機能の全体トグル。app_settings の 1 行 = 1 機能で、値は 'true' / 'false' の文字列。
// 「行が無い / 'false' 以外」は有効 — 設定行を消しても既存機能が消えないように。
const FEATURES = [
  {
    key: 'tags_enabled',
    label: 'タグを表示する',
    help: 'オフにするとタグバッジ・絞り込み・タグ検索と、この画面のタグ管理が消えます。登録済みのタグと割り当ては削除されません。',
  },
] as const

type FeatureKey = (typeof FEATURES)[number]['key']

interface State {
  enabled: Record<FeatureKey, boolean>
  loading: boolean
  error: string | null
}

type Action =
  | { type: 'loadOk'; enabled: Record<FeatureKey, boolean> }
  | { type: 'loadErr'; error: string }
  | { type: 'set'; key: FeatureKey; value: boolean }
  | { type: 'saveErr'; error: string }

// useState のセッターを useEffect 内で直接呼ぶと react-hooks/set-state-in-effect
// (eslint) に引っかかるため、既存の TagsSettings / ReadmeSearchPanel と同じく
// useReducer + dispatch で持つ。
function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'loadOk':
      return { enabled: a.enabled, loading: false, error: null }
    case 'loadErr':
      return { ...s, loading: false, error: a.error }
    case 'set':
      return { ...s, enabled: { ...s.enabled, [a.key]: a.value }, error: null }
    case 'saveErr':
      return { ...s, error: a.error }
  }
}

const ALL_ENABLED = Object.fromEntries(
  FEATURES.map(f => [f.key, true]),
) as Record<FeatureKey, boolean>

// 機能の表示/非表示。設定はアプリ全体で 1 つ
// (LAN 共有・認証なし、README / Favorites と同じ契約)。
// 接続ごとの権限 (ConnectionForm の「この接続で許可する操作」) とは別物 —
// あちらは S3 への操作を止めるもので、こちらは単なる画面の出し分け。
export function FeatureSettings() {
  const [state, dispatch] = useReducer(reducer, {
    enabled: ALL_ENABLED, loading: true, error: null,
  })

  useEffect(() => {
    let cancelled = false
    api.settings()
      .then(s => {
        if (cancelled) return
        dispatch({
          type: 'loadOk',
          enabled: Object.fromEntries(
            FEATURES.map(f => [f.key, s[f.key] !== 'false']),
          ) as Record<FeatureKey, boolean>,
        })
      })
      .catch((e: Error) => { if (!cancelled) dispatch({ type: 'loadErr', error: e.message }) })
    return () => { cancelled = true }
  }, [])

  const toggle = async (key: FeatureKey, next: boolean) => {
    // 楽観更新。失敗したら元に戻してエラーを出す (TagPicker と同じ方針)。
    dispatch({ type: 'set', key, value: next })
    try {
      await api.putSetting(key, next ? 'true' : 'false')
    } catch (e) {
      dispatch({ type: 'set', key, value: !next })
      dispatch({ type: 'saveErr', error: (e as Error).message })
    }
  }

  return (
    <section className="mt-7">
      <div
        className="mb-3 flex items-baseline justify-between gap-3 pb-2"
        style={{ borderBottom: '1px solid var(--rule)' }}
      >
        <h3 className={sectionTitleClass}>機能</h3>
      </div>

      {state.error && <p className="error">{state.error}</p>}

      {FEATURES.map(({ key, label, help }) => (
        <div key={key} className="mb-2">
          <label className="flex items-center gap-2 px-1 py-2 text-[13px] text-ink-11">
            <input
              type="checkbox"
              checked={state.enabled[key]}
              disabled={state.loading}
              onChange={e => void toggle(key, e.target.checked)}
            />
            <span>{label}</span>
          </label>
          <p className="px-1 text-[12px] text-ink-7">{help}</p>
        </div>
      ))}
    </section>
  )
}
