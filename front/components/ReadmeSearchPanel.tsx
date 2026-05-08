import { useEffect, useReducer, useRef } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api/client'
import { encPath } from '../lib/route'

interface Props {
  connId: string
}

interface Hit {
  bucket: string
  prefix: string
  editor: string
  edited_at: string
  size_bytes: number
}

interface State {
  q: string
  hits: Hit[] | null
  loading: boolean
  error: string | null
}

type Action =
  | { type: 'setQ'; q: string }
  | { type: 'startSearch' }
  | { type: 'reset' }
  | { type: 'resetWithEmptyQ' }
  | { type: 'searchOk'; hits: Hit[] }
  | { type: 'searchErr'; error: string }

const initial: State = { q: '', hits: null, loading: false, error: null }

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'setQ':
      return { ...s, q: a.q }
    case 'startSearch':
      return { ...s, loading: true, error: null }
    case 'reset':
      return { ...s, hits: null, loading: false, error: null }
    case 'resetWithEmptyQ':
      return { q: '', hits: null, loading: false, error: null }
    case 'searchOk':
      return { ...s, hits: a.hits, loading: false }
    case 'searchErr':
      return { ...s, error: a.error, loading: false }
  }
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('ja-JP')
}

const SEARCH_DEBOUNCE_MS = 250

// 接続内の README 全文検索パネル。input ≥ 2 文字で debounce してリクエスト。
// 結果は最新版のみ対象、クリックでその prefix へ遷移する。
export function ReadmeSearchPanel({ connId }: Props) {
  const [state, dispatch] = useReducer(reducer, initial)
  const { q, hits, loading, error } = state

  const debounceRef = useRef<number | null>(null)
  const sessionRef = useRef(0)

  // connId 切替時に検索状態をリセット (異なる接続に同じ q を引き継がない)。
  useEffect(() => {
    if (debounceRef.current != null) window.clearTimeout(debounceRef.current)
    sessionRef.current++
    dispatch({ type: 'resetWithEmptyQ' })
  }, [connId])

  const onChangeQ = (next: string) => {
    dispatch({ type: 'setQ', q: next })
    if (debounceRef.current != null) window.clearTimeout(debounceRef.current)
    if (next.trim().length < 2) {
      dispatch({ type: 'reset' })
      return
    }
    dispatch({ type: 'startSearch' })
    const sid = ++sessionRef.current
    debounceRef.current = window.setTimeout(() => {
      api.readmesSearch(connId, next.trim())
        .then(r => {
          if (sessionRef.current !== sid) return
          dispatch({ type: 'searchOk', hits: r.hits })
        })
        .catch((e: Error) => {
          if (sessionRef.current !== sid) return
          dispatch({ type: 'searchErr', error: e.message })
        })
    }, SEARCH_DEBOUNCE_MS)
  }

  useEffect(() => {
    return () => {
      if (debounceRef.current != null) window.clearTimeout(debounceRef.current)
    }
  }, [])

  return (
    <section className="mt-3 mb-4">
      <div className="flex items-center gap-2">
        <input
          type="search"
          className="flex-1 max-w-[480px] rounded-1 bg-paper px-3 py-1.5 text-[13px] focus:outline-none"
          style={{
            border: '1px solid var(--color-rule-strong)',
            fontFamily: 'var(--font-sans)',
          }}
          placeholder="README 全文検索 (2 文字以上)"
          value={q}
          onChange={e => onChangeQ(e.target.value)}
          aria-label="README 全文検索"
        />
        {loading && (
          <span className="text-[11px] text-ink-7">検索中…</span>
        )}
      </div>

      {error && <p className="error mt-2">{error}</p>}

      {hits !== null && hits.length === 0 && !loading && !error && (
        <p className="mt-3 text-[12px] text-ink-7">ヒットなし。</p>
      )}

      {hits !== null && hits.length > 0 && (
        <ul
          className="m-0 mt-3 list-none p-0"
          style={{ borderTop: '1px solid var(--rule)' }}
        >
          {hits.map(h => {
            const to =
              `/storage/${encodeURIComponent(connId)}` +
              `/${encodeURIComponent(h.bucket)}/${encPath(h.prefix)}`
            return (
              <li
                key={`${h.bucket}/${h.prefix}`}
                className="py-2.5 px-1 transition-colors hover:bg-ink-0"
                style={{ borderBottom: '1px solid var(--rule)' }}
              >
                <Link to={to} className="block text-ink-12 no-underline">
                  <span
                    className="text-[12.5px] text-ink-7"
                    style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.005em' }}
                  >
                    {h.bucket}/
                  </span>
                  <span
                    className="text-[12.5px] font-medium text-ink-12"
                    style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.005em' }}
                  >
                    {h.prefix || '(root)'}
                  </span>
                </Link>
                <div
                  className="mt-0.5 text-[10.5px] text-ink-7 tabular-nums"
                  style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.02em' }}
                >
                  last by <span className="text-ink-9">{h.editor}</span>{' '}
                  <span className="text-ink-3">·</span>{' '}
                  {fmtTime(h.edited_at)}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
