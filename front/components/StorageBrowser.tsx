import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { z } from 'zod'
import { api } from '../lib/api/client'
import { StorageList } from '../lib/api/types'
import type { Tag } from '../lib/api/types'
import { EntryTable } from './storage/EntryTable'
import { CacheBanner } from './storage/CacheBanner'
import { ScanModal } from './storage/ScanModal'
import { Pager } from './storage/Pager'
import { SearchBar } from './storage/SearchBar'
import { TagFilterBar } from './storage/TagFilterBar'
import { useTagsEnabled } from '../lib/useFeatureEnabled'

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
  // 期限切れキャッシュを表示したまま裏で再取得中 (stale-while-revalidate)。
  // loading とは別軸: 画面には既にデータが出ているので操作は止めない。
  revalidating: boolean
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
  | { type: 'revalidateStart' }
  | { type: 'revalidateOk'; page: ListResp }
  | { type: 'revalidateFail' }

const initial: State = {
  q: '',
  submittedQ: '',
  recursive: false,
  page: null,
  history: [{}],
  pageIdx: 0,
  loading: true,
  error: null,
  revalidating: false,
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
      return { ...s, history: [{}], pageIdx: 0, loading: true, error: null, revalidating: false }
    case 'startGoto':
      return { ...s, pageIdx: a.idx, loading: true, error: null, revalidating: false }
    case 'startNext':
      return { ...s, history: [...s.history, a.cursor], pageIdx: s.pageIdx + 1, loading: true, error: null, revalidating: false }
    case 'loadOk':
      // stale の可能性があるので revalidating はここでは触らない
      return { ...s, page: a.page, loading: false }
    case 'loadErr':
      return { ...s, error: a.error, loading: false, revalidating: false }
    case 'revalidateStart':
      return { ...s, revalidating: true }
    case 'revalidateOk':
      return { ...s, page: a.page, revalidating: false }
    // 再取得に失敗しても表示中の stale は残す — 画面を壊さず「更新中」を消すだけ。
    case 'revalidateFail':
      return { ...s, revalidating: false }
  }
}

export function StorageBrowser({ connId, bucket, prefix, onSelectFile }: Props) {
  const tagsEnabled = useTagsEnabled()
  const [state, dispatch] = useReducer(reducer, initial)
  const { q, submittedQ, recursive, page, history, pageIdx, loading, error, revalidating } = state

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
  const load = useCallback((cursor: Cursor, opts: { force?: boolean; refresh?: boolean } = {}) => {
    const sid = ++sessionRef.current
    api.list(connId, bucket, effectivePrefix, cursor, {
      recursive,
      force: opts.force,
      refresh: opts.refresh,
      // 期限切れキャッシュが返ってきたときだけ呼ばれる。表示は stale のまま進み、
      // ここで受け取った Promise が解決したら差し替える。
      onRevalidate: fresh => {
        if (sessionRef.current !== sid) return
        dispatch({ type: 'revalidateStart' })
        fresh
          .then(r => {
            if (sessionRef.current !== sid) return
            dispatch({ type: 'revalidateOk', page: r })
          })
          .catch(() => {
            if (sessionRef.current !== sid) return
            dispatch({ type: 'revalidateFail' })
          })
      },
    })
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
  // refresh:true でサーバー側キャッシュも貫通する。これが無いとユーザーは
  // 最大 24 時間 古いデータから逃げられない。ページ送りの force とは別物で、
  // あちらを貫通させると dataset では 1 ページ送るのに 35 秒かかる。
  const forceRefresh = (): void => {
    api.invalidateList(connId, bucket, prefix)
    dispatch({ type: 'identityReset' })
    load({}, { refresh: true })
  }

  const dirs = page?.directories ?? []
  const files = page?.files ?? []

  // タグ: レジストリ全件 + 表示中の dirs/files 分のバッチ割り当てを取得する。
  // dirs/files が変わるたび (ページ送り・検索・prefix 遷移) に再取得する。
  const [allTags, setAllTags] = useState<Tag[]>([])
  const [dirTags, setDirTags] = useState<Record<string, string[]>>({})
  const [fileTags, setFileTags] = useState<Record<string, string[]>>({})
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set())
  // 走査は「いま開いているディレクトリ」だけを対象にする (README と同じスコープ)。
  // 行の ⋯ から任意のサブディレクトリを走査する導線は作らない。
  const [scanOpen, setScanOpen] = useState(false)

  useEffect(() => {
    if (!tagsEnabled) return
    api.tags().then(setAllTags).catch(() => {})
  }, [connId, tagsEnabled])

  useEffect(() => {
    if (!tagsEnabled) return
    let cancelled = false
    Promise.all([
      api.tagAssignments(connId, bucket, 'prefix', dirs),
      api.tagAssignments(connId, bucket, 'file', files.map(f => f.key)),
    ]).then(([d, f]) => {
      if (cancelled) return
      setDirTags(d)
      setFileTags(f)
    }).catch(() => {})
    return () => { cancelled = true }
    // dirs/files は毎レンダ新しい配列参照になるため、実際の中身 (キー結合) で比較する。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, bucket, tagsEnabled, dirs.join(' '), files.map(f => f.key).join(' ')])

  const handleTagsChange = useCallback((path: string, tagIds: string[]) => {
    setDirTags(prev => (path in prev || dirs.includes(path)) ? { ...prev, [path]: tagIds } : prev)
    setFileTags(prev => (path in prev || files.some(f => f.key === path)) ? { ...prev, [path]: tagIds } : prev)
  }, [dirs, files])

  const tagsByPath = useMemo(() => ({ ...dirTags, ...fileTags }), [dirTags, fileTags])

  // 絞り込みチップの候補: 今表示中の行に実際に出現するタグのみ。
  const visibleTagIds = useMemo(() => new Set(Object.values(tagsByPath).flat()), [tagsByPath])
  const filterCandidates = useMemo(
    () => allTags.filter(t => visibleTagIds.has(t.id)),
    [allTags, visibleTagIds],
  )

  const matchesSelectedTags = useCallback((path: string): boolean => {
    if (selectedTagIds.size === 0) return true
    const ids = tagsByPath[path] ?? []
    return ids.some(id => selectedTagIds.has(id))
  }, [selectedTagIds, tagsByPath])

  const visibleDirs = useMemo(() => dirs.filter(matchesSelectedTags), [dirs, matchesSelectedTags])
  const visibleFiles = useMemo(() => files.filter(f => matchesSelectedTags(f.key)), [files, matchesSelectedTags])

  const toggleTagFilter = useCallback((tagId: string) => {
    setSelectedTagIds(prev => {
      const next = new Set(prev)
      if (next.has(tagId)) next.delete(tagId); else next.add(tagId)
      return next
    })
  }, [setSelectedTagIds])

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
  const isEmpty = !loading && visibleDirs.length === 0 && visibleFiles.length === 0
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

      {/* 読み込み中も操作は塞がない。↻ はサーバーキャッシュを貫通するので
          dataset では 35 秒かかり、その間ずっと触れないのは実用に耐えない。
          表示中の一覧を触っても困らない: プレビューはオブジェクトキーで開くので
          一覧の入れ替わりと独立で、ディレクトリ遷移は sessionRef が進行中の
          応答を破棄する。薄さは「更新中である」ことの合図として残す。 */}
      <div
        aria-busy={loading}
        className={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}
      >
        {tagsEnabled && (
          <TagFilterBar
            tags={filterCandidates}
            selected={selectedTagIds}
            onToggle={toggleTagFilter}
            onClear={() => setSelectedTagIds(new Set())}
          />
        )}
        {/* 「いつのデータか」はテーブルヘッダの真上に置く。ページャの隅では
            視線が届かず、古いキャッシュを最新だと思って見てしまうため。 */}
        <CacheBanner
          fetchedAt={api.lastFetched.list(connId, bucket, effectivePrefix, history[pageIdx] ?? {}, { recursive })}
          revalidating={revalidating}
          onRefresh={forceRefresh}
          onScan={() => setScanOpen(true)}
        />
        {scanOpen && (
          <ScanModal
            connId={connId}
            bucket={bucket}
            prefix={effectivePrefix}
            onClose={() => setScanOpen(false)}
          />
        )}
        <EntryTable
          dirs={visibleDirs}
          files={visibleFiles}
          prefix={prefix}
          connId={connId}
          bucket={bucket}
          onSelectFile={onSelectFile}
          allTags={allTags}
          tagsByPath={tagsByPath}
          onTagsChange={handleTagsChange}
          tagsEnabled={tagsEnabled}
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
        />
      </div>
    </div>
  )
}
