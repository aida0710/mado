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

// hits/loading/error は useReducer で持つ。useState のセッターを useEffect 内で
// 直接呼ぶと react-hooks/set-state-in-effect (eslint) に引っかかるが、
// useReducer の dispatch はこのルールの対象外 (ReadmeSearchPanel と同じ既存パターン)。
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

const KIND_LABEL: Record<Hit['kind'], string> = {
  bucket: 'バケット', prefix: 'ディレクトリ', file: 'ファイル',
}

// タグ検索。Storage (バケット一覧) からリンクで開く独立したビュー。
//
// もとはバケット一覧の上に畳んだパネルとして置いていたが、README 検索 /
// S3 パス貼付と並んで一覧の前に積み上がり、ページが混み合っていた。
// 選んだタグのいずれかが付いた bucket/ディレクトリ/ファイルを列挙する (OR)。
export function TagSearchView({ connId }: Props) {
  const [allTags, setAllTags] = useState<Tag[]>([])
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [search, dispatch] = useReducer(searchReducer, initialSearch)
  const { hits, loading, error } = search

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

  return (
    <section>
      {allTags.length === 0 ? (
        <p className="mt-4 text-[13px] text-ink-7">
          タグがまだありません。<Link to="/settings">Settings</Link> で作成してください。
        </p>
      ) : (
        <>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {allTags.map(tag => (
              <button
                key={tag.id}
                type="button"
                onClick={() => toggle(tag.id)}
                className="cursor-pointer border-0 bg-transparent p-0"
                // 未選択は淡くするが 0.4 だと薄い。バッジ自体が淡いティントに
                // なったので、それより薄くすると読めなくなる。
                style={{ opacity: selected.size === 0 || selected.has(tag.id) ? 1 : 0.55 }}
                aria-pressed={selected.has(tag.id)}
              >
                <TagBadge tag={tag} />
              </button>
            ))}
            {selected.size > 0 && (
              <button type="button" className="ghost" onClick={() => setSelected(new Set())}>
                クリア
              </button>
            )}
            {loading && <span className="text-[11px] text-ink-7">検索中…</span>}
          </div>

          {error && <p className="error mt-3">{error}</p>}

          {selected.size === 0 && !error && (
            <p className="mt-4 text-[13px] text-ink-7">タグを選ぶと、付いている場所を一覧します。</p>
          )}

          {hits !== null && hits.length === 0 && !loading && !error && (
            <p className="mt-4 text-[13px] text-ink-7">この接続にヒットなし。</p>
          )}

          {hits !== null && hits.length > 0 && (
            <>
              <p className="mt-5 text-[10.5px] font-semibold uppercase tracking-[0.22em] text-ink-7">
                {hits.length} 件
              </p>
              <ul className="m-0 mt-2 list-none p-0" style={{ borderTop: '1px solid var(--rule)' }}>
                {hits.map(h => (
                  <li
                    key={`${h.tagId}|${h.bucket}|${h.kind}|${h.path}`}
                    className="px-1 py-2.5 transition-colors hover:bg-ink-0"
                    style={{ borderBottom: '1px solid var(--rule)' }}
                  >
                    <Link to={hrefFor(connId, h)} className="block text-ink-12 no-underline">
                      <span className="wrap-anywhere">
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
                      </span>
                      <span className="mt-0.5 block text-[11px] text-ink-7">
                        {KIND_LABEL[h.kind]}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  )
}
