import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Link } from 'react-router-dom'
import type { z } from 'zod'
import { api } from '../lib/api/client'
import { StorageList } from '../lib/api/types'
import { fmtSize } from '../lib/format'
import { encPath } from '../lib/route'
import { CopyMenu } from './CopyMenu'
import type { MenuItem } from './CopyMenu'

interface Props {
  connId: string
  bucket: string
  prefix: string
  onSelectFile?: (key: string) => void
}

type ListResp = z.infer<typeof StorageList>
type FileEntry = ListResp['files'][number]

const headThClass =
  'border-b border-ink-2 px-2 py-2 text-left text-[11px] font-medium uppercase tracking-[0.06em] text-ink-7'
const tdNameClass =
  'max-w-0 overflow-hidden text-ellipsis whitespace-nowrap border-b border-ink-1 px-2 py-2'
const tdNumClass =
  'w-px whitespace-nowrap border-b border-ink-1 px-2 py-2 text-right tabular-nums text-ink-7'
// File rows: 行全体クリック (preview drawer 開閉) なので pointer cursor
const fileRowClass =
  'cursor-pointer transition-colors hover:bg-ink-0 focus-within:bg-ink-1'
// Dir rows: クリック領域は内側の <Link> だけ。inert セルでは pointer を出さない
const dirRowClass =
  'transition-colors hover:bg-ink-0 focus-within:bg-ink-1'

type Cursor = { continuation?: string; startAfter?: string }

const nextCursor = (p: ListResp): Cursor | null =>
  p.nextContinuation
    ? { continuation: p.nextContinuation }
    : p.nextStartAfter
    ? { startAfter: p.nextStartAfter }
    : null

// 検索 input の debounce 時間。ReadmeSearchPanel と揃える。
const SEARCH_DEBOUNCE_MS = 250

// IntersectionObserver の rootMargin。ユーザがスクロール末尾に着く
// 少し手前で先読みして「途切れず流れる」体感にする。
const SENTINEL_ROOT_MARGIN = '200px'

// 行ごとに memo 化することで、StorageBrowser が loading フラグや scroll
// 起動の loadMore で再レンダしても、エントリが変わらない既存行は描画を
// スキップできる。各行は items: MenuItem[] を内部で useMemo して
// CopyMenu の memo を活かす。
const DirRow = memo(function DirRow({
  d, prefix, connId, bucket,
}: { d: string; prefix: string; connId: string; bucket: string }) {
  // 表示は現ディレクトリ基準で末尾を切る。検索中は effectivePrefix が
  // `prefix + q` だが、入っているキーは prefix で始まるのでそのまま slice。
  const tail = d.startsWith(prefix) ? d.slice(prefix.length) : d
  const dirHref = `/storage/${encodeURIComponent(connId)}/${encodeURIComponent(bucket)}/${encPath(d)}`
  const dirS3Url = `s3://${bucket}/${d}`
  const dirWebUrl = `${window.location.origin}${dirHref}`
  const items = useMemo<MenuItem[]>(() => [
    { kind: 'copy', label: 'Web URL をコピー', value: dirWebUrl },
    { kind: 'copy', label: 'S3 URL をコピー', value: dirS3Url },
  ], [dirWebUrl, dirS3Url])
  return (
    <tr className={dirRowClass}>
      <td className={`${tdNameClass} p-0`}>
        <Link
          to={dirHref}
          className="block px-2 py-2 font-semibold text-ink-11 no-underline"
        >
          📁 {tail}
        </Link>
      </td>
      <td className={tdNumClass}>—</td>
      <td className={tdNumClass}>—</td>
      <td className={tdNumClass}>
        <CopyMenu items={items} />
      </td>
    </tr>
  )
})

const FileRow = memo(function FileRow({
  f, prefix, connId, bucket, onSelectFile,
}: {
  f: FileEntry
  prefix: string
  connId: string
  bucket: string
  onSelectFile?: (key: string) => void
}) {
  const tail = f.key.startsWith(prefix) ? f.key.slice(prefix.length) : f.key
  const select = useCallback(() => onSelectFile?.(f.key), [onSelectFile, f.key])
  // Enter / Space で preview を開く。dir 行は <Link> がネイティブで処理する。
  const onKeyDown = useCallback((e: KeyboardEvent<HTMLTableRowElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      select()
    }
  }, [select])
  // Web URL は dashboard origin + 現在ナビゲーション + ?preview=<key>。
  // 別ユーザに送ると「直リンクで preview drawer が開く」共有 URL になる。
  const webUrl = `${window.location.origin}`
    + `/storage/${encodeURIComponent(connId)}/${encodeURIComponent(bucket)}/${encPath(prefix)}`
    + `?preview=${encodeURIComponent(f.key)}`
  const s3Url = `s3://${bucket}/${f.key}`
  const downloadUrl = api.downloadUrl(connId, bucket, f.key)
  const filename = f.key.split('/').pop() ?? 'file'
  const items = useMemo<MenuItem[]>(() => [
    { kind: 'download', label: 'このファイルをダウンロード', href: downloadUrl, filename },
    { kind: 'copy',     label: 'Web URL をコピー',           value: webUrl },
    { kind: 'copy',     label: 'S3 URL をコピー',            value: s3Url },
  ], [downloadUrl, webUrl, s3Url, filename])
  return (
    <tr
      className={fileRowClass}
      role="button"
      tabIndex={0}
      onClick={select}
      onKeyDown={onKeyDown}
    >
      <td className={tdNameClass}>📄 {tail}</td>
      <td className={tdNumClass}>{fmtSize(f.size)}</td>
      <td className={tdNumClass}>{f.lastModified?.slice(0, 10) ?? ''}</td>
      <td className={tdNumClass}>
        <CopyMenu items={items} />
      </td>
    </tr>
  )
})

export function StorageBrowser({ connId, bucket, prefix, onSelectFile }: Props) {
  // 検索クエリ — 既定は現ディレクトリ "直下" の前方一致 (= S3 ListObjectsV2 の
  // Prefix を `prefix + q` にして Delimiter='/' のまま投げる)。
  // 再帰チェックを入れると Delimiter を外して配下を全て flat に列挙する
  // (CommonPrefixes は空になるので結果は全部 ファイル行 として並ぶ)。
  const [q, setQ] = useState('')
  const [submittedQ, setSubmittedQ] = useState('')
  const [recursive, setRecursive] = useState(false)

  // q を debounce して submittedQ に反映。これが effective prefix を駆動する。
  useEffect(() => {
    const t = setTimeout(() => setSubmittedQ(q), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [q])

  // 別ディレクトリへ移動したら検索ボックスと再帰チェックもクリアする。
  // さもないと /etc/ で "config" 再帰検索中に /var/ に移ると /var/ 全体を再帰
  // 走査し続けることになりユーザの意図と乖離する。
  useEffect(() => {
    setQ('')
    setSubmittedQ('')
    setRecursive(false)
  }, [connId, bucket, prefix])

  const effectivePrefix = prefix + submittedQ

  // ページネーション撤廃 → 全 chunk を順に append していく単一リスト。
  const [dirs, setDirs] = useState<string[]>([])
  const [files, setFiles] = useState<FileEntry[]>([])
  const [cursor, setCursor] = useState<Cursor | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)        // 1 chunk 目 (リセット時)
  const [loadingMore, setLoadingMore] = useState(false) // 2 chunk 目以降
  const [error, setError] = useState<string | null>(null)

  // 並行 fetch (素早い prefix 切替 / 検索キー入力) で stale chunk が
  // append されないように「セッション ID」で gate する。
  // sessionRef を bump → それ以前の Promise の result は捨てる。
  const sessionRef = useRef(0)

  // 1 chunk 目: 既存の dirs/files は表示したまま、新しい chunk が届いたら置換。
  // → stale-while-revalidate により prefix 切替時に画面が空にならない
  // (既存テストが「古い内容が dim で残る」ことを確認しているのでこの挙動は維持)。
  const startNew = (): void => {
    const sid = ++sessionRef.current
    setError(null)
    setLoading(true)
    api.list(connId, bucket, effectivePrefix, {}, { recursive })
      .then(r => {
        if (sessionRef.current !== sid) return
        setDirs(r.directories)
        setFiles(r.files)
        const nc = nextCursor(r)
        setCursor(nc)
        setHasMore(!!nc)
      })
      .catch((e: Error) => {
        if (sessionRef.current !== sid) return
        setError(e.message)
      })
      .finally(() => {
        if (sessionRef.current !== sid) return
        setLoading(false)
      })
  }

  // 接続/バケット/prefix/検索クエリ/再帰フラグのいずれかが変わったら新規セッション。
  useEffect(() => {
    startNew()
    // startNew は state setter 群を閉じ込んだクロージャ。依存に入れると毎レンダで
    // 再生成され無限ループするので明示列挙。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, bucket, prefix, submittedQ, recursive])

  // sentinel が画面に入ったら次 chunk を append。
  // - cursor が null (= 最終 chunk まで取得済み) → 何もしない
  // - 既に in-flight → 何もしない (= IO 連発を吸収)
  const loadMore = (): void => {
    if (loadingMore || loading || !cursor) return
    const sid = sessionRef.current
    setLoadingMore(true)
    api.list(connId, bucket, effectivePrefix, cursor, { recursive })
      .then(r => {
        if (sessionRef.current !== sid) return
        // 重複防止: API は通常 cursor 境界で重複しないが、DDN 互換 S3 で
        // StartAfter フォールバック時に最終キーが再出することがあるため
        // key/path で de-dup する。
        setDirs(d => {
          const seen = new Set(d)
          return [...d, ...r.directories.filter(x => !seen.has(x))]
        })
        setFiles(f => {
          const seen = new Set(f.map(x => x.key))
          return [...f, ...r.files.filter(x => !seen.has(x.key))]
        })
        const nc = nextCursor(r)
        setCursor(nc)
        setHasMore(!!nc)
      })
      .catch((e: Error) => {
        if (sessionRef.current !== sid) return
        setError(e.message)
      })
      .finally(() => {
        if (sessionRef.current !== sid) return
        setLoadingMore(false)
      })
  }

  const sentinelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const node = sentinelRef.current
    if (!node) return
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) loadMore()
    }, { rootMargin: SENTINEL_ROOT_MARGIN })
    io.observe(node)
    return () => io.disconnect()
    // loadMore を毎レンダで再観測するため cursor / loading 状態を deps に入れる
    // (= cursor 取得済み or loading 解除直後に再評価される)。loadMore 自体は
    // クロージャだが、内部で session gate するため stale capture は無害。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, loading, loadingMore, hasMore])

  // 当該ディレクトリ全体のキャッシュを破棄して 1 chunk 目から再 fetch。
  // 別ユーザがアップロード / 削除した直後に押す想定。検索中でも
  // 同じ prefix で前方一致 invalidate されるので search 結果も新鮮になる。
  const forceRefresh = (): void => {
    api.invalidateList(connId, bucket, prefix)
    startNew()
  }

  const isEmpty = !loading && dirs.length === 0 && files.length === 0
  const isSearching = submittedQ.length > 0

  return (
    <div>
      {/* 検索 input + 再帰チェック。
          再帰オフ: 現ディレクトリ "直下" の前方一致 (Delimiter='/')。
          再帰オン: prefix 配下を全て flat に列挙 (Delimiter なし)、
                  検索クエリ空でもサブディレクトリ全件を一覧できる便利モード。 */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <input
          type="search"
          className="flex-1 max-w-[480px] rounded-2 border border-ink-3 bg-paper px-3 py-1.5 text-sm"
          placeholder={recursive
            ? 'このディレクトリ配下を検索 (前方一致・再帰)'
            : 'このディレクトリ内を検索 (前方一致)'}
          value={q}
          onChange={e => setQ(e.target.value)}
          aria-label="ディレクトリ内検索"
        />
        <label className="flex cursor-pointer items-center gap-1 text-xs text-ink-9">
          <input
            type="checkbox"
            checked={recursive}
            onChange={e => setRecursive(e.target.checked)}
          />
          再帰検索
        </label>
        {isSearching && (
          <button
            type="button"
            onClick={() => setQ('')}
            className="cursor-pointer rounded-2 border border-ink-3 bg-paper px-2 py-1 text-xs transition-colors hover:bg-ink-1"
            aria-label="検索をクリア"
          >
            クリア
          </button>
        )}
      </div>

      {/* 進捗バー領域: 高さ 2px を常時確保しレイアウトシフトを避ける。
          loading (1 chunk 目) のときだけバー要素を描画する。loadingMore は
          下のセンチネル横に小さな indicator を出すので兼用しない。 */}
      <div className="relative h-[2px] w-full overflow-hidden bg-ink-1">
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
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <th className={headThClass}>Name</th>
              <th className={`${headThClass} text-right`}>Size</th>
              <th className={`${headThClass} text-right`}>Modified</th>
              <th className={headThClass}></th>
            </tr>
          </thead>
          <tbody>
            {dirs.map(d => (
              <DirRow key={d} d={d} prefix={prefix} connId={connId} bucket={bucket} />
            ))}
            {files.map(f => (
              <FileRow
                key={f.key}
                f={f}
                prefix={prefix}
                connId={connId}
                bucket={bucket}
                onSelectFile={onSelectFile}
              />
            ))}
          </tbody>
        </table>

        {isEmpty && !error && (
          <p className="py-4 text-center text-xs text-ink-7">
            {isSearching
              ? `「${submittedQ}」に一致するエントリはありません${recursive ? ' (再帰)' : ''}。`
              : recursive
              ? 'このディレクトリ配下にエントリがありません。'
              : '空のディレクトリです。'}
          </p>
        )}

        {/* 末尾センチネル: hasMore のときだけマウント。IntersectionObserver が
            これを観測し画面に入ったら loadMore() を呼ぶ。 */}
        {hasMore && (
          <div ref={sentinelRef} className="flex items-center justify-center py-3 text-xs text-ink-7">
            {loadingMore ? '読み込み中…' : '↓ さらに読み込む'}
          </div>
        )}

        {/* hasMore が false なら「end」ラベル + refresh のみ。検索の有無に関わらず常に出す。 */}
        <div className="flex items-center justify-center gap-3 py-3 text-xs text-ink-7 tabular-nums">
          {!hasMore && !isEmpty && (
            <span>
              {dirs.length + files.length} 件 (全件表示済み)
            </span>
          )}
          <button
            className="cursor-pointer rounded-2 border border-ink-3 bg-paper px-3 py-1 transition-colors hover:bg-ink-1 hover:border-ink-5 disabled:cursor-default disabled:opacity-40"
            onClick={forceRefresh}
            disabled={loading || loadingMore}
            title="キャッシュを破棄して再読み込み"
          >
            🔄
          </button>
        </div>
      </div>
    </div>
  )
}
