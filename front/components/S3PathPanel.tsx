// S3 パスジャンプパネル — StorageIndex (バケット一覧) で README 検索の下に置く。
//
// `s3://bucket/prefix/` を貼り付けてバケット階層を 1 段ずつ潜らずに深い場所へ移動する。
// パスが不完全 (末尾が `/` でない) なら前方一致した結果を出す = `s3cmd ls s3://bucket/par`
// と同じ挙動。これは内部的に api.list(connId, bucket, prefix) を叩くだけで成立する
// (S3 が delimiter 付き ListObjects で prefix 前方一致を返すため)。
//
// 末尾 `/` (= 実在ディレクトリ指定) や bucket 直下の場合は「→ 開く」リンク + Enter で
// 直接そのページへ遷移できる。

import { useEffect, useReducer, useRef, type KeyboardEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { z } from 'zod'
import { api } from '../lib/api/client'
import { StorageList } from '../lib/api/types'
import { encPath, fileLinkToDirRedirect, parseS3Path } from '../lib/route'

interface Props {
  connId: string
}

type ListData = z.infer<typeof StorageList>

interface State {
  raw: string
  loading: boolean
  error: string | null
  // 直近で成功した listing と、その時の bucket / prefix (表示名の相対計算に使う)。
  result: { bucket: string; prefix: string; data: ListData } | null
}

type Action =
  | { type: 'setRaw'; raw: string }
  | { type: 'startSearch' }
  | { type: 'searchOk'; bucket: string; prefix: string; data: ListData }
  | { type: 'searchErr'; error: string }
  | { type: 'clear' }
  | { type: 'resetForConn' }

const initial: State = { raw: '', loading: false, error: null, result: null }

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'setRaw':       return { ...s, raw: a.raw }
    case 'startSearch':  return { ...s, loading: true, error: null }
    case 'searchOk':     return { ...s, loading: false, error: null, result: { bucket: a.bucket, prefix: a.prefix, data: a.data } }
    case 'searchErr':    return { ...s, loading: false, error: a.error, result: null }
    case 'clear':        return { ...s, loading: false, error: null, result: null }
    case 'resetForConn': return { raw: '', loading: false, error: null, result: null }
  }
}

const SEARCH_DEBOUNCE_MS = 300

const inputClass =
  'flex-1 max-w-[480px] rounded-1 bg-paper px-3 py-1.5 text-[13px] focus:outline-none'
const rowLinkClass =
  'block overflow-hidden text-ellipsis whitespace-nowrap text-[12.5px] text-ink-12 no-underline hover:underline underline-offset-[3px]'

export function S3PathPanel({ connId }: Props) {
  const [state, dispatch] = useReducer(reducer, initial)
  const { raw, loading, error, result } = state
  const navigate = useNavigate()
  const debounceRef = useRef<number | null>(null)
  const sessionRef = useRef(0)

  // connId 切替時に状態をリセット (別接続に同じ入力を引き継がない)。
  useEffect(() => {
    if (debounceRef.current != null) window.clearTimeout(debounceRef.current)
    sessionRef.current++
    dispatch({ type: 'resetForConn' })
  }, [connId])

  useEffect(() => () => {
    if (debounceRef.current != null) window.clearTimeout(debounceRef.current)
  }, [])

  const parsed = parseS3Path(raw)
  // 末尾 `/` または bucket 直下 (prefix 空) は「実在ディレクトリ指定」とみなし、
  // Enter / 「開く」で直接そのページへ遷移できる。末尾が `/` でない中途半端な
  // prefix は前方一致の途中なので「開く」対象にしない。
  const canOpenDirectly =
    parsed != null && (parsed.prefix === '' || parsed.prefix.endsWith('/'))
  const openHref = parsed
    ? `/storage/${encodeURIComponent(connId)}/${encodeURIComponent(parsed.bucket)}/${encPath(parsed.prefix)}`
    : null

  const onChange = (next: string) => {
    dispatch({ type: 'setRaw', raw: next })
    if (debounceRef.current != null) window.clearTimeout(debounceRef.current)
    const p = parseS3Path(next)
    if (!p) { dispatch({ type: 'clear' }); return }
    dispatch({ type: 'startSearch' })
    const sid = ++sessionRef.current
    debounceRef.current = window.setTimeout(() => {
      api.list(connId, p.bucket, p.prefix, {}, { recursive: false })
        .then(data => {
          if (sessionRef.current !== sid) return
          dispatch({ type: 'searchOk', bucket: p.bucket, prefix: p.prefix, data })
        })
        .catch((e: Error) => {
          if (sessionRef.current !== sid) return
          dispatch({ type: 'searchErr', error: e.message })
        })
    }, SEARCH_DEBOUNCE_MS)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && canOpenDirectly && openHref) {
      navigate(openHref)
    }
  }

  // 表示名: 入力 prefix の「最後の / まで」を剥がした相対パス (s3cmd ls 同様)。
  const relName = (full: string): string => {
    const p = result?.prefix ?? ''
    return full.slice(p.lastIndexOf('/') + 1)
  }

  const dirs = result?.data.directories ?? []
  const files = result?.data.files ?? []
  const isEmpty = result != null && dirs.length === 0 && files.length === 0
  const hasMore = !!(result && (result.data.nextContinuation || result.data.nextStartAfter))

  return (
    <section className="mt-3 mb-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          className={inputClass}
          style={{ border: '1px solid var(--color-rule-strong)', fontFamily: 'var(--font-mono)' }}
          placeholder="s3://bucket/prefix/ で移動 (前方一致)"
          value={raw}
          onChange={e => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="S3 パスで移動"
          spellCheck={false}
        />
        {loading && <span className="text-[11px] text-ink-7">検索中…</span>}
        {canOpenDirectly && openHref && (
          <Link
            to={openHref}
            className="text-[12px] text-ink-9 no-underline hover:text-ink-12 hover:underline underline-offset-[3px]"
          >
            → {parsed!.bucket}/{parsed!.prefix} を開く
          </Link>
        )}
      </div>

      {error && <p className="error mt-2">{error}</p>}

      {isEmpty && !loading && !error && (
        <p className="mt-3 text-[12px] text-ink-7">一致するパスがありません。</p>
      )}

      {result && (dirs.length > 0 || files.length > 0) && (
        <ul
          className="m-0 mt-3 list-none p-0"
          style={{ borderTop: '1px solid var(--rule)' }}
        >
          {dirs.map(d => (
            <li
              key={d}
              className="py-2 px-1 transition-colors hover:bg-ink-0"
              style={{ borderBottom: '1px solid var(--rule)' }}
            >
              <Link
                to={`/storage/${encodeURIComponent(connId)}/${encodeURIComponent(result.bucket)}/${encPath(d)}`}
                className={rowLinkClass}
                style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.005em' }}
              >
                <span aria-hidden>📁 </span>{relName(d)}
              </Link>
            </li>
          ))}
          {files.map(f => (
            <li
              key={f.key}
              className="py-2 px-1 transition-colors hover:bg-ink-0"
              style={{ borderBottom: '1px solid var(--rule)' }}
            >
              <Link
                to={fileLinkToDirRedirect(connId, result.bucket, f.key)}
                className={rowLinkClass}
                style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.005em' }}
              >
                <span aria-hidden>📄 </span>{relName(f.key)}
              </Link>
            </li>
          ))}
        </ul>
      )}

      {hasMore && (
        <p className="mt-2 text-[11px] text-ink-7">
          結果が多すぎます。パスをもう少し具体的に入力してください。
        </p>
      )}
    </section>
  )
}
