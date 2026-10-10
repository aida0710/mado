import { useEffect, useReducer, useRef } from 'react'
import { Link } from 'react-router-dom'
import { Search } from 'lucide-react'
import { api } from '../lib/api/client'
import { encPath } from '../lib/route'
import { useCapabilities } from '../lib/useCapabilities'

interface Props {
  connectionId: string
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
export function ReadmeSearchPanel({ connectionId }: Props) {
  const caps = useCapabilities(connectionId)
  const [state, dispatch] = useReducer(reducer, initial)
  const { q, hits, loading, error } = state

  const debounceRef = useRef<number | null>(null)
  const sessionRef = useRef(0)

  // connectionId 切替時に検索状態をリセット (異なる接続に同じ q を引き継がない)。
  useEffect(() => {
    if (debounceRef.current != null) window.clearTimeout(debounceRef.current)
    sessionRef.current++
    dispatch({ type: 'resetWithEmptyQ' })
  }, [connectionId])

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
      api.readmesSearch(connectionId, next.trim())
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

  // 読み込みが無効な接続では README 検索の意味が無いのでパネルごと隠す。
  if (!caps.readmeRead) return null

  return (
    <section className="readme-search">
      {/* 隣の「S3 パスで移動」と同じ、虫眼鏡と枠の無い入力の帯 (storage.css の .storage-search)。 */}
      <div className="storage-search" role="search">
        <Search size={16} aria-hidden="true" />
        <input
          type="search"
          placeholder="README 全文検索 (2 文字以上)"
          value={q}
          onChange={e => onChangeQ(e.target.value)}
          aria-label="README 全文検索"
        />
        {loading && <span className="muted nowrap">検索中…</span>}
      </div>

      {error && <p className="notice error">{error}</p>}

      {hits !== null && hits.length === 0 && !loading && !error && (
        <p className="muted readme-search__message">ヒットなし。</p>
      )}

      {hits !== null && hits.length > 0 && (
        <ul className="readme-search__hits">
          {hits.map(h => {
            const to =
              `/storage/${encodeURIComponent(connectionId)}` +
              `/${encodeURIComponent(h.bucket)}/${encPath(h.prefix)}`
            return (
              <li key={`${h.bucket}/${h.prefix}`}>
                <Link to={to} className="readme-search__path">
                  <span className="muted">{h.bucket}/</span>
                  {h.prefix || '(root)'}
                </Link>
                <span className="muted">
                  last by {h.editor} · {fmtTime(h.edited_at)}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
