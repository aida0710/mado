import { useEffect, useReducer } from 'react'
import { api } from '../lib/api/client'

const sectionTitleClass =
  'm-0 text-[10.5px] font-semibold uppercase tracking-[0.22em] text-ink-7'

interface State {
  lineageEnabled: boolean
  loading: boolean
  error: string | null
}

type Action =
  | { type: 'loadOk'; lineageEnabled: boolean }
  | { type: 'loadErr'; error: string }
  | { type: 'saving' }
  | { type: 'saved'; lineageEnabled: boolean }
  | { type: 'saveErr'; error: string }

// useState のセッターを useEffect 内で直接呼ぶと react-hooks/set-state-in-effect
// (eslint) に引っかかるため、既存の TagsSettings / ReadmeSearchPanel と同じく
// useReducer + dispatch で持つ。
function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'loadOk':
      return { lineageEnabled: a.lineageEnabled, loading: false, error: null }
    case 'loadErr':
      return { ...s, loading: false, error: a.error }
    case 'saving':
      return { ...s, error: null }
    case 'saved':
      return { ...s, lineageEnabled: a.lineageEnabled }
    case 'saveErr':
      return { ...s, error: a.error }
  }
}

// 機能の表示/非表示。今は家系図タブのみ。
// 設定はアプリ全体で 1 つ (LAN 共有・認証なし、README / Favorites と同じ契約)。
export function FeatureSettings() {
  const [state, dispatch] = useReducer(reducer, {
    lineageEnabled: true, loading: true, error: null,
  })

  useEffect(() => {
    let cancelled = false
    api.settings()
      .then(s => {
        if (!cancelled) dispatch({ type: 'loadOk', lineageEnabled: s.lineage_enabled !== 'false' })
      })
      .catch((e: Error) => { if (!cancelled) dispatch({ type: 'loadErr', error: e.message }) })
    return () => { cancelled = true }
  }, [])

  const toggle = async (next: boolean) => {
    // 楽観更新。失敗したら元に戻してエラーを出す (TagPicker と同じ方針)。
    dispatch({ type: 'saving' })
    dispatch({ type: 'saved', lineageEnabled: next })
    try {
      await api.putSetting('lineage_enabled', next ? 'true' : 'false')
    } catch (e) {
      dispatch({ type: 'saved', lineageEnabled: !next })
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

      <label className="flex items-center gap-2 px-1 py-2 text-[13px] text-ink-11">
        <input
          type="checkbox"
          checked={state.lineageEnabled}
          disabled={state.loading}
          onChange={e => void toggle(e.target.checked)}
        />
        <span>家系図タブを表示する</span>
      </label>
      <p className="px-1 text-[12px] text-ink-7">
        オフにするとバケット画面とバケット一覧から「家系図」の導線が消えます。登録済みのリンクは削除されません。
      </p>
    </section>
  )
}
