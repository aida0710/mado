import { useEffect, useReducer, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api/client'
import type { Tag, TagSearchResult } from '../lib/api/types'
import { encPath, fileLinkToDirRedirect } from '../lib/route'
import { TagBadge } from './TagBadge'

interface Props {
  connId: string
  /** 選択候補。表示中の行に出現するものだけでなく全タグを出す
   *  (今の一覧に無いタグを選ぶと「一覧は空 + 他の場所にある」が分かるため)。 */
  allTags: Tag[]
  selected: Set<string>
  onToggle: (tagId: string) => void
  onClear: () => void
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

const headLabelClass =
  'text-[10.5px] font-semibold uppercase tracking-[0.22em] text-ink-7'

// タグの絞り込みと接続内横断検索をひとつにまとめたパネル。
//
// 以前は「タグで横断検索」と「タグで絞り込み」が同じ見た目のチップ列として
// 縦に 2 本並んでおり、片方は結果が増え片方は行が減る、という別物なのに
// 区別がつかなかった。チップ列を 1 本にし、選択で
//   ・表示中の一覧を絞り込む (呼び出し側が selected を見て行を減らす)
//   ・同じ選択で接続全体を検索し、ヒットを下に畳んで出す
// の両方が同時に起きるようにして、「今見えている範囲」と「接続全体」を
// 親子関係で並べる。
//
// 既定は畳んだ状態。畳んでいる間は選択中のタグそのものは出さず、件数だけを
// ラベルに添える (絞り込みが効いていること自体は分かるようにする)。
export function TagPanel({ connId, allTags, selected, onToggle, onClear }: Props) {
  const [open, setOpen] = useState(false)
  const [hitsOpen, setHitsOpen] = useState(false)
  const [search, dispatch] = useReducer(searchReducer, initialSearch)
  const { hits, loading, error } = search

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

  if (allTags.length === 0) return null


  const chip = (tag: Tag) => (
    <button
      key={tag.id}
      type="button"
      onClick={() => onToggle(tag.id)}
      className="cursor-pointer border-0 bg-transparent p-0"
      style={{ opacity: selected.size === 0 || selected.has(tag.id) ? 1 : 0.4 }}
      aria-pressed={selected.has(tag.id)}
    >
      <TagBadge tag={tag} />
    </button>
  )

  return (
    <section className="mt-3 mb-4">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="ghost"
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
        >
          <span aria-hidden>{open ? '▾' : '▸'}</span>
          <span className={headLabelClass}>タグ</span>
          {/* 畳んでいる間、選択中のタグそのものは出さない (閉じたら閉じたまま
              にする)。ただし絞り込みが効いていること自体が見えないと行が減った
              理由が分からないので、件数だけラベルに添える。 */}
          {selected.size > 0 && (
            <span className={headLabelClass}>({selected.size})</span>
          )}
        </button>
      </div>

      {open && (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {allTags.map(chip)}
            {selected.size > 0 && (
              <button type="button" className="ghost" onClick={onClear}>クリア</button>
            )}
            {loading && <span className="text-[11px] text-ink-7">検索中…</span>}
          </div>

          {error && <p className="error mt-2">{error}</p>}

          {hits !== null && hits.length === 0 && !loading && !error && (
            <p className="mt-3 text-[12px] text-ink-7">この接続にヒットなし。</p>
          )}

          {hits !== null && hits.length > 0 && (
            <div className="mt-3">
              <button
                type="button"
                className="ghost"
                onClick={() => setHitsOpen(o => !o)}
                aria-expanded={hitsOpen}
              >
                <span aria-hidden>{hitsOpen ? '▾' : '▸'}</span>
                接続全体のヒット {hits.length} 件
              </button>
              {hitsOpen && (
                <ul className="m-0 mt-3 list-none p-0" style={{ borderTop: '1px solid var(--rule)' }}>
                  {hits.map(h => (
                    <li
                      key={`${h.tagId}|${h.bucket}|${h.kind}|${h.path}`}
                      className="px-1 py-2.5 transition-colors hover:bg-ink-0"
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
            </div>
          )}
        </>
      )}
    </section>
  )
}
