import { useCallback, useEffect, useReducer, useRef } from 'react'
import type { z } from 'zod'
import { api } from '../lib/api/client'
import { StorageList } from '../lib/api/types'
import { EntryTable } from './storage/EntryTable'
import { Pager } from './storage/Pager'
import { SearchBar } from './storage/SearchBar'

interface Props {
  connId: string
  bucket: string
  prefix: string
  onSelectFile?: (key: string) => void
}

type ListResp = z.infer<typeof StorageList>
type Cursor = { continuation?: string; startAfter?: string }

const nextCursor = (p: ListResp): Cursor | null =>
  p.nextContinuation
    ? { continuation: p.nextContinuation }
    : p.nextStartAfter
    ? { startAfter: p.nextStartAfter }
    : null

// 検索 input の debounce 時間。ReadmeSearchPanel と揃える。
const SEARCH_DEBOUNCE_MS = 250

interface State {
  q: string
  submittedQ: string
  recursive: boolean
  page: ListResp | null
  history: Cursor[]
  pageIdx: number
  loading: boolean
  error: string | null
}

type Action =
  | { type: 'setQ'; q: string }
  | { type: 'submitQuery'; q: string }
  | { type: 'setRecursive'; r: boolean }
  | { type: 'identityReset' }
  | { type: 'startGoto'; idx: number }
  | { type: 'startNext'; cursor: Cursor }
  | { type: 'loadOk'; page: ListResp }
  | { type: 'loadErr'; error: string }

const initial: State = {
  q: '',
  submittedQ: '',
  recursive: false,
  page: null,
  history: [{}],
  pageIdx: 0,
  loading: true,
  error: null,
}

// 注: page は reset 時にもクリアしない。前ページの dirs/files は応答到着まで
// 残ることで、ページ切替中も画面が空にならず dim 状態として表示される。
function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'setQ':
      return { ...s, q: a.q }
    case 'submitQuery':
      return { ...s, submittedQ: a.q }
    case 'setRecursive':
      return { ...s, recursive: a.r }
    case 'identityReset':
      return { ...s, history: [{}], pageIdx: 0, loading: true, error: null }
    case 'startGoto':
      return { ...s, pageIdx: a.idx, loading: true, error: null }
    case 'startNext':
      return { ...s, history: [...s.history, a.cursor], pageIdx: s.pageIdx + 1, loading: true, error: null }
    case 'loadOk':
      return { ...s, page: a.page, loading: false }
    case 'loadErr':
      return { ...s, error: a.error, loading: false }
  }
}

export function StorageBrowser({ connId, bucket, prefix, onSelectFile }: Props) {
  const [state, dispatch] = useReducer(reducer, initial)
  const { q, submittedQ, recursive, page, history, pageIdx, loading, error } = state

  // 並行 fetch (素早い prefix 切替 / 検索キー入力 / ページャ連打) で stale 応答を
  // 反映しないように「セッション ID」で gate する。bump → 以前の Promise は捨てる。
  const sessionRef = useRef(0)
  // 検索入力の debounce タイマー。
  const debounceRef = useRef<number | null>(null)

  const effectivePrefix = prefix + submittedQ

  // 単一ページ取得 (replace)。
  // force=true で forward navigation 時にキャッシュをバイパスする
  // (DDN 製などの S3 互換が cursor を進めずに同じトークンを返してくるとき、
  //  cache key 衝突で前ページのデータが返ってしまう問題への防衛)。
  const load = useCallback((cursor: Cursor, opts: { force?: boolean } = {}) => {
    const sid = ++sessionRef.current
    api.list(connId, bucket, effectivePrefix, cursor, { recursive, force: opts.force })
      .then(r => {
        if (sessionRef.current !== sid) return
        dispatch({ type: 'loadOk', page: r })
      })
      .catch((e: Error) => {
        if (sessionRef.current !== sid) return
        dispatch({ type: 'loadErr', error: e.message })
      })
  }, [connId, bucket, effectivePrefix, recursive])

  // 接続/バケット/prefix/検索クエリ/再帰フラグのいずれかが変わったら 1 ページ目から fetch。
  // (load の deps が変わると ref 再生成 → ここが再 trigger される。)
  useEffect(() => {
    dispatch({ type: 'identityReset' })
    load({})
  }, [load])

  // unmount 時に debounce タイマーを掃除する。
  useEffect(() => {
    return () => {
      if (debounceRef.current != null) window.clearTimeout(debounceRef.current)
    }
  }, [])

  // 検索 input: setQ + debounce → submitQuery (effective prefix が変わると
  // 上の load effect が再 fire される)。
  const onChangeQ = (next: string) => {
    dispatch({ type: 'setQ', q: next })
    if (debounceRef.current != null) window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => {
      dispatch({ type: 'submitQuery', q: next })
    }, SEARCH_DEBOUNCE_MS)
  }
  const onClearQ = () => {
    if (debounceRef.current != null) window.clearTimeout(debounceRef.current)
    dispatch({ type: 'setQ', q: '' })
    dispatch({ type: 'submitQuery', q: '' })
  }

  // 次ページ。current の応答に nextCursor が無ければ no-op。
  // 既に「戻る」で過去ページに居て、次の history が積まれているならそれを再利用。
  // 未訪問ページへ進むときは force:true でキャッシュをバイパスする。
  const next = (): void => {
    if (!page || loading || !hasNext) return
    const c = nextCursor(page)
    if (!c) return
    if (pageIdx + 1 < history.length) {
      const newIdx = pageIdx + 1
      dispatch({ type: 'startGoto', idx: newIdx })
      load(history[newIdx])
    } else {
      dispatch({ type: 'startNext', cursor: c })
      load(c, { force: true })
    }
  }

  const prev = (): void => {
    if (pageIdx === 0 || loading) return
    const newIdx = pageIdx - 1
    dispatch({ type: 'startGoto', idx: newIdx })
    load(history[newIdx])
  }

  // 訪問済みページへのジャンプ。S3 は前方向 cursor のみなので、
  // history に積まれていないページにはこの API では飛べない。
  const goto = (idx: number): void => {
    if (idx < 0 || idx >= history.length || idx === pageIdx || loading) return
    dispatch({ type: 'startGoto', idx })
    load(history[idx])
  }

  // 当該ディレクトリ全体のキャッシュを破棄して 1 ページ目から再 fetch。
  const forceRefresh = (): void => {
    api.invalidateList(connId, bucket, prefix)
    dispatch({ type: 'identityReset' })
    load({})
  }

  const dirs = page?.directories ?? []
  const files = page?.files ?? []
  // hasNext は「次がある」だけでなく「server が cursor を進めるか」も判定する。
  // DDN 製などの S3 互換は IsTruncated=true でも ContinuationToken / 最終キーが
  // 進まないことがあり、その状態で「次」を押しても同じデータしか返らないため
  // 末尾扱いにして disable する。
  const hasNext = (() => {
    if (!page) return false
    const c = nextCursor(page)
    if (!c) return false
    const used = history[pageIdx] ?? {}
    return c.continuation !== used.continuation || c.startAfter !== used.startAfter
  })()
  const cursorStuck = !!(page && nextCursor(page) && !hasNext)
  const isEmpty = !loading && dirs.length === 0 && files.length === 0
  const isSearching = submittedQ.length > 0
  const isTrailingPage = pageIdx === history.length - 1
  const totalLabel = isTrailingPage && hasNext
    ? `${pageIdx + 1} / ${history.length}+`
    : `${pageIdx + 1} / ${history.length}`

  return (
    <div>
      <SearchBar
        q={q}
        recursive={recursive}
        isSearching={isSearching}
        onChangeQ={onChangeQ}
        onToggleRecursive={r => dispatch({ type: 'setRecursive', r })}
        onClear={onClearQ}
      />

      {/* 進捗バー領域: 高さ 2px を常時確保しレイアウトシフトを避ける。 */}
      <div
        className="relative h-px w-full overflow-hidden"
        style={{ background: 'var(--rule)' }}
      >
        {loading && (
          <div
            role="progressbar"
            aria-label="読み込み中"
            className="storage-progress h-full w-1/3 bg-ink-9"
          />
        )}
      </div>

      {error && <p className="error">{error}</p>}

      <div
        aria-busy={loading}
        className={loading ? 'pointer-events-none opacity-60 transition-opacity' : 'transition-opacity'}
      >
        <EntryTable
          dirs={dirs}
          files={files}
          prefix={prefix}
          connId={connId}
          bucket={bucket}
          onSelectFile={onSelectFile}
        />

        {isEmpty && !error && (
          <p className="py-6 text-center text-[13px] text-ink-7">
            {isSearching
              ? `「${submittedQ}」に一致するエントリはありません${recursive ? ' (再帰)' : ''}。`
              : recursive
              ? 'このディレクトリ配下にエントリがありません。'
              : '空のディレクトリです。'}
          </p>
        )}

        <Pager
          pageIdx={pageIdx}
          history={history}
          hasNext={hasNext}
          cursorStuck={cursorStuck}
          loading={loading}
          isEmpty={isEmpty}
          totalLabel={totalLabel}
          entryCount={dirs.length + files.length}
          onPrev={prev}
          onNext={next}
          onGoto={goto}
          onRefresh={forceRefresh}
        />
      </div>
    </div>
  )
}
