import { useEffect, useReducer, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api/client'
import type { LineageLink } from '../lib/api/types'
import { nodeKind } from '../lib/lineageGraph'
import { encPath, fileLinkToDirRedirect } from '../lib/route'

interface Props {
  connId: string
}

const headLabelClass =
  'text-[10.5px] font-semibold uppercase tracking-[0.22em] text-ink-7'

// LineageNodePopup / LineageGraphCanvas と同じ記号を使う。
const KIND_ICON: Record<'bucket' | 'directory' | 'file', string> = {
  bucket: '📦', directory: '📁', file: '📄',
}

// 家系図ビューは 1 ノードを中心に祖先/子孫を辿る作りなので、「どのリンクが
// 登録されているか」を俯瞰できない。ここでは接続内の全リンクを素直に
// 親 → 子 の一覧として出す。
function nodeHref(connId: string, bucket: string, path: string): string {
  const kind = nodeKind(path)
  if (kind === 'bucket') return `/storage/${encodeURIComponent(connId)}/${encodeURIComponent(bucket)}/`
  if (kind === 'directory') {
    return `/storage/${encodeURIComponent(connId)}/${encodeURIComponent(bucket)}/${encPath(path)}`
  }
  return fileLinkToDirRedirect(connId, bucket, path)
}

function NodeLink({ connId, bucket, path }: { connId: string; bucket: string; path: string }) {
  const kind = nodeKind(path)
  return (
    <Link
      to={nodeHref(connId, bucket, path)}
      className="inline-flex min-w-0 items-baseline gap-1.5 text-ink-12 no-underline hover:underline underline-offset-[3px]"
    >
      <span aria-hidden className="shrink-0">{KIND_ICON[kind]}</span>
      <span
        className="wrap-anywhere text-[12.5px]"
        style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.005em' }}
      >
        {path === '' ? bucket : `${bucket}/${path}`}
      </span>
    </Link>
  )
}

interface State {
  links: LineageLink[] | null
  error: string | null
}

type Action =
  | { type: 'ok'; links: LineageLink[] }
  | { type: 'err'; error: string }

// useState のセッターを useEffect 内で直接呼ぶと react-hooks/set-state-in-effect
// (eslint) に引っかかるため useReducer + dispatch で持つ (既存パターン)。
function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'ok':
      return { links: a.links, error: null }
    case 'err':
      return { ...s, error: a.error }
  }
}

// Storage (バケット一覧) に置く、接続内の家系図リンク一覧。
// 既定は畳んだ状態 (TagPanel と揃える)。
export function LineageListPanel({ connId }: Props) {
  const [open, setOpen] = useState(false)
  const [state, dispatch] = useReducer(reducer, { links: null, error: null })
  const { links, error } = state

  useEffect(() => {
    let cancelled = false
    api.lineageLinks(connId)
      .then(r => { if (!cancelled) dispatch({ type: 'ok', links: r }) })
      .catch((e: Error) => { if (!cancelled) dispatch({ type: 'err', error: e.message }) })
    return () => { cancelled = true }
  }, [connId])

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
          <span className={headLabelClass}>家系図</span>
          {links !== null && (
            <span className={headLabelClass}>({links.length})</span>
          )}
        </button>
      </div>

      {open && (
        <>
          {error && <p className="error mt-2">{error}</p>}

          {links !== null && links.length === 0 && !error && (
            <p className="mt-3 text-[12px] text-ink-7">
              リンクがまだありません。バケットやディレクトリの家系図タブから追加できます。
            </p>
          )}

          {links !== null && links.length > 0 && (
            <ul className="m-0 mt-3 list-none p-0" style={{ borderTop: '1px solid var(--rule)' }}>
              {links.map(l => (
                <li
                  key={l.id}
                  className="px-1 py-2.5"
                  style={{ borderBottom: '1px solid var(--rule)' }}
                >
                  {/* 狭い画面では 親 / 子 が縦積みになる。矢印は子と同じ塊にして
                      「→ 子」で折り返す — 矢印だけが単独行に残ると、どちらへ
                      向かっているのかが読み取りづらい。 */}
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <NodeLink connId={connId} bucket={l.parentBucket} path={l.parentPath} />
                    <span className="inline-flex min-w-0 items-baseline gap-2">
                      <span aria-hidden className="shrink-0 text-ink-5">→</span>
                      <NodeLink connId={connId} bucket={l.childBucket} path={l.childPath} />
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  )
}
