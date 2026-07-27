import { useEffect, useReducer, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api/client'
import type { Tag, TagSearchResult } from '../lib/api/types'
import { encPath, fileLinkToDirRedirect } from '../lib/route'
import { TagBadge } from './TagBadge'

interface Props {
  connId: string
}

type Hit = TagSearchResult[number]

function hrefFor(connId: string, hit: Hit): string {
  if (hit.kind === 'bucket') {
    return `/storage/${encodeURIComponent(connId)}/${encodeURIComponent(hit.bucket)}/`
  }
  if (hit.kind === 'prefix') {
    return `/storage/${encodeURIComponent(connId)}/${encodeURIComponent(hit.bucket)}/${encPath(hit.path)}`
  }
  return fileLinkToDirRedirect(connId, hit.bucket, hit.path)
}

// hits/loading/error は ReadmeSearchPanel と同じく useReducer + dispatch で持つ。
// useState のセッターを useEffect 内で直接呼ぶと react-hooks/set-state-in-effect
// (eslint) に引っかかるが、useReducer の dispatch はこのルールの対象外
// (ReadmeSearchPanel.tsx で確認済みの既存パターンを踏襲)。
interface SearchState {
  hits: TagSearchResult | null
  loading: boolean
  error: string | null
}

type SearchAction =
  | { type: 'idle' }
  | { type: 'start' }
  | { type: 'ok'; hits: TagSearchResult }
  | { type: 'err'; error: string }

const initialSearch: SearchState = { hits: null, loading: false, error: null }

function searchReducer(s: SearchState, a: SearchAction): SearchState {
  switch (a.type) {
    case 'idle':
      return initialSearch
    case 'start':
      return { ...s, loading: true, error: null }
    case 'ok':
      return { ...s, hits: a.hits, loading: false }
    case 'err':
      return { ...s, error: a.error, loading: false }
  }
}

// ReadmeSearchPanel と同じ位置 (StorageIndex 上部) に置く、タグの接続内横断検索。
// 選んだタグのいずれかが付いた bucket/ディレクトリ/ファイルを列挙する (OR)。
export function TagSearchPanel({ connId }: Props) {
  const [allTags, setAllTags] = useState<Tag[]>([])
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [search, dispatch] = useReducer(searchReducer, initialSearch)
  const { hits, loading, error } = search

  // connId が切り替わったら選択タグをリセットする。useEffect 内で直接 setState
  // すると react-hooks/set-state-in-effect (eslint) に引っかかるため、React 公式の
  // 「レンダー中に前回値と比較して調整する」パターンに置き換える
  // (https://react.dev/learn/you-might-not-need-an-effect#adjusting-state-based-on-a-prop-or-state-change)。
  const [lastConnId, setLastConnId] = useState(connId)
  if (lastConnId !== connId) {
    setLastConnId(connId)
    setSelected(new Set())
  }

  useEffect(() => {
    api.tags().then(setAllTags).catch(() => {})
  }, [connId])

  useEffect(() => {
    if (selected.size === 0) {
      dispatch({ type: 'idle' })
      return
    }
    let cancelled = false
    dispatch({ type: 'start' })
    api.tagSearch(connId, [...selected])
      .then(r => { if (!cancelled) dispatch({ type: 'ok', hits: r }) })
      .catch((e: Error) => { if (!cancelled) dispatch({ type: 'err', error: e.message }) })
    return () => { cancelled = true }
  }, [connId, selected])

  const toggle = (tagId: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(tagId)) next.delete(tagId); else next.add(tagId)
      return next
    })
  }

  if (allTags.length === 0) return null

  return (
    <section className="mt-3 mb-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.22em] text-ink-7">
          タグで横断検索
        </span>
        {allTags.map(tag => (
          <button
            key={tag.id}
            type="button"
            onClick={() => toggle(tag.id)}
            className="border-0 bg-transparent p-0 cursor-pointer"
            style={{ opacity: selected.size === 0 || selected.has(tag.id) ? 1 : 0.4 }}
            aria-pressed={selected.has(tag.id)}
          >
            <TagBadge tag={tag} />
          </button>
        ))}
        {loading && <span className="text-[11px] text-ink-7">検索中…</span>}
      </div>

      {error && <p className="error mt-2">{error}</p>}

      {hits !== null && hits.length === 0 && !loading && !error && (
        <p className="mt-3 text-[12px] text-ink-7">ヒットなし。</p>
      )}

      {hits !== null && hits.length > 0 && (
        <ul className="m-0 mt-3 list-none p-0" style={{ borderTop: '1px solid var(--rule)' }}>
          {hits.map(h => (
            <li
              key={`${h.tagId}|${h.bucket}|${h.kind}|${h.path}`}
              className="py-2.5 px-1 transition-colors hover:bg-ink-0"
              style={{ borderBottom: '1px solid var(--rule)' }}
            >
              <Link to={hrefFor(connId, h)} className="block text-ink-12 no-underline">
                <span
                  className="text-[12.5px] text-ink-7"
                  style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.005em' }}
                >
                  {h.bucket}<span>/</span>
                </span>
                <span
                  className="text-[12.5px] font-medium text-ink-12"
                  style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.005em' }}
                >
                  {h.kind === 'bucket' ? '(bucket root)' : h.path}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
