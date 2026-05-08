import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
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

export function StorageBrowser({ connId, bucket, prefix, onSelectFile }: Props) {
  // 検索クエリ — 現ディレクトリ "直下" の前方一致 (= S3 ListObjectsV2 の Prefix を
  // `prefix + q` にして Delimiter='/' のまま投げる)。サブディレクトリ配下は
  // 含めない仕様 (再帰検索したくなったら別エンドポイントに切る)。
  const [q, setQ] = useState('')
  const [submittedQ, setSubmittedQ] = useState('')

  // q を debounce して submittedQ に反映。これが effective prefix を駆動する。
  useEffect(() => {
    const t = setTimeout(() => setSubmittedQ(q), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [q])

  // 別ディレクトリへ移動したら検索ボックスもクリアする。さもないと
  // /etc/ で "config" 検索中に /var/ に移ると /var/config* を検索する形になり
  // ユーザの意図と乖離する。
  useEffect(() => {
    setQ('')
    setSubmittedQ('')
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
    api.list(connId, bucket, effectivePrefix, {})
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

  // 接続/バケット/prefix/検索クエリのいずれかが変わったら新規セッション。
  useEffect(() => {
    startNew()
    // startNew は state setter 群を閉じ込んだクロージャ。依存に入れると毎レンダで
    // 再生成され無限ループするので明示列挙。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, bucket, prefix, submittedQ])

  // sentinel が画面に入ったら次 chunk を append。
  // - cursor が null (= 最終 chunk まで取得済み) → 何もしない
  // - 既に in-flight → 何もしない (= IO 連発を吸収)
  const loadMore = (): void => {
    if (loadingMore || loading || !cursor) return
    const sid = sessionRef.current
    setLoadingMore(true)
    api.list(connId, bucket, effectivePrefix, cursor)
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

  // File rows のキーボード操作 (Enter/Space で preview を開く) 用ヘルパー。
  // dir 行は <Link> がネイティブにキーボード処理する。
  const activate = (fn: () => void) => (e: KeyboardEvent<HTMLTableRowElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      fn()
    }
  }

  const isEmpty = !loading && dirs.length === 0 && files.length === 0
  const isSearching = submittedQ.length > 0

  return (
    <div>
      {/* 検索 input — 現ディレクトリ直下の前方一致 (再帰なし) */}
      <div className="mb-2 flex items-center gap-2">
        <input
          type="search"
          className="flex-1 max-w-[480px] rounded-2 border border-ink-3 bg-paper px-3 py-1.5 text-sm"
          placeholder="このディレクトリ内を検索 (前方一致)"
          value={q}
          onChange={e => setQ(e.target.value)}
          aria-label="ディレクトリ内検索"
        />
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
            {dirs.map(d => {
              // 表示は現ディレクトリ基準で末尾を切る。検索中は effectivePrefix が
              // `prefix + q` だが、入っているキーは prefix で始まるのでそのまま slice。
              const tail = d.startsWith(prefix) ? d.slice(prefix.length) : d
              const dirHref = `/storage/${encodeURIComponent(connId)}/${encodeURIComponent(bucket)}/${encPath(d)}`
              const dirS3Url  = `s3://${bucket}/${d}`
              const dirWebUrl = `${window.location.origin}${dirHref}`
              const items: MenuItem[] = [
                { kind: 'copy', label: 'Web URL をコピー', value: dirWebUrl },
                { kind: 'copy', label: 'S3 URL をコピー', value: dirS3Url  },
              ]
              return (
                <tr key={d} className={dirRowClass}>
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
            })}
            {files.map(f => {
              const tail = f.key.startsWith(prefix) ? f.key.slice(prefix.length) : f.key
              const select = () => onSelectFile?.(f.key)
              const s3Url = `s3://${bucket}/${f.key}`
              // Web URL は dashboard origin + 現在ナビゲーション + ?preview=<key>
              // 別ユーザに送るときに「直リンクで preview drawer が開く」。
              const webUrl =
                `${window.location.origin}` +
                `/storage/${encodeURIComponent(connId)}/${encodeURIComponent(bucket)}/${encPath(prefix)}` +
                `?preview=${encodeURIComponent(f.key)}`
              const downloadUrl = api.downloadUrl(connId, bucket, f.key)
              const filename = f.key.split('/').pop() ?? 'file'
              const items: MenuItem[] = [
                { kind: 'download', label: 'このファイルをダウンロード', href: downloadUrl, filename },
                { kind: 'copy',     label: 'Web URL をコピー',           value: webUrl },
                { kind: 'copy',     label: 'S3 URL をコピー',            value: s3Url },
              ]
              return (
                <tr
                  key={f.key}
                  className={fileRowClass}
                  role="button"
                  tabIndex={0}
                  onClick={select}
                  onKeyDown={activate(select)}
                >
                  <td className={tdNameClass}>📄 {tail}</td>
                  <td className={tdNumClass}>{fmtSize(f.size)}</td>
                  <td className={tdNumClass}>{f.lastModified?.slice(0, 10) ?? ''}</td>
                  <td className={tdNumClass}>
                    <CopyMenu items={items} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>

        {isEmpty && !error && (
          <p className="py-4 text-center text-xs text-ink-7">
            {isSearching ? `「${submittedQ}」に一致するエントリはありません。` : '空のディレクトリです。'}
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
