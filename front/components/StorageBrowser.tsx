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

// Editorial table: ヘッダ small caps + 0.22em tracking、罫線は hairline (var(--rule))
const headThClass =
  'px-2 py-2 text-left text-[10.5px] font-semibold uppercase tracking-[0.22em] text-ink-7'
// 行内 cell。下端 hairline。tdNumClass は右寄せ + tabular-nums。
const tdNameClass =
  'max-w-0 overflow-hidden text-ellipsis whitespace-nowrap px-2 py-2.5'
const tdNumClass =
  'w-px whitespace-nowrap px-2 py-2.5 text-right tabular-nums text-ink-7 ' +
  'font-mono text-[12px]'
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
    <tr className={dirRowClass} style={{ borderBottom: '1px solid var(--rule)' }}>
      <td className={`${tdNameClass} p-0`}>
        <Link
          to={dirHref}
          className={
            'flex items-baseline gap-2 px-2 py-2.5 ' +
            'font-semibold text-ink-12 no-underline'
          }
        >
          {/* dir glyph: chevron — folder シンボルとしての editorial 表現 */}
          <span aria-hidden className="text-ink-5 select-none text-[10px]">▸</span>
          <span className="truncate">{tail}</span>
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
      style={{ borderBottom: '1px solid var(--rule)' }}
      role="button"
      tabIndex={0}
      onClick={select}
      onKeyDown={onKeyDown}
    >
      <td className={tdNameClass}>
        <span className="flex items-baseline gap-2">
          {/* file glyph: 控えめな点 — タイポ的に存在を主張しすぎない */}
          <span aria-hidden className="text-ink-3 select-none text-[10px]">·</span>
          <span
            className="truncate text-ink-11"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '12.5px',
              letterSpacing: '0.005em',
            }}
          >
            {tail}
          </span>
        </span>
      </td>
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

  // ページ単位でリストを取得 (append しない)。
  // - page: 現ページの ListResp (directories / files / nextContinuation / nextStartAfter)
  // - history: 訪問済みページの cursor 履歴。history[i] は「ページ i+1 を
  //   取りに行くときに渡す cursor」。history[0] は常に {} (= 1 ページ目)。
  // - pageIdx: 現在のページ index (0-based)。表示は pageIdx + 1。
  // S3 は前方向 cursor のみ提供するので、戻る/任意ページジャンプは「訪問済み」に限る。
  const [page, setPage] = useState<ListResp | null>(null)
  const [history, setHistory] = useState<Cursor[]>([{}])
  const [pageIdx, setPageIdx] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 並行 fetch (素早い prefix 切替 / 検索キー入力 / ページャ連打) で stale 応答を
  // 反映しないように「セッション ID」で gate する。bump → 以前の Promise は捨てる。
  const sessionRef = useRef(0)

  // 単一ページ取得 (replace)。前ページの dirs/files は応答到着まで残るので
  // ページ切替中も画面が空にならない (aria-busy + opacity-60 で dim 表現)。
  // force=true で forward navigation 時にキャッシュをバイパスする
  // (DDN/MDX 互換 S3 が cursor を進めずに同じトークンを返してくるとき、
  //  cache key 衝突で前ページのデータが返ってしまう問題への防衛)。
  const load = (cursor: Cursor, opts: { force?: boolean } = {}): void => {
    const sid = ++sessionRef.current
    setError(null)
    setLoading(true)
    api.list(connId, bucket, effectivePrefix, cursor, { recursive, force: opts.force })
      .then(r => {
        if (sessionRef.current !== sid) return
        setPage(r)
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

  // 接続/バケット/prefix/検索クエリ/再帰フラグのいずれかが変わったら 1 ページ目に戻す。
  useEffect(() => {
    setHistory([{}])
    setPageIdx(0)
    load({})
    // load は state setter を閉じ込んだクロージャ。依存に入れると毎レンダで
    // 再生成され無限ループするので明示列挙。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, bucket, prefix, submittedQ, recursive])

  // 次ページ。current の応答に nextCursor が無ければ no-op。
  // 既に「戻る」で過去ページに居て、次の history が積まれているならそれを再利用
  // (= 同じページに同じ cursor で戻れる)。最後尾なら history を伸ばす。
  // 未訪問ページへ進むときは force:true でキャッシュをバイパスする。
  const next = (): void => {
    if (!page || loading || !hasNext) return
    const c = nextCursor(page)
    if (!c) return
    if (pageIdx + 1 < history.length) {
      const newIdx = pageIdx + 1
      setPageIdx(newIdx)
      load(history[newIdx])
    } else {
      setHistory(h => [...h, c])
      setPageIdx(i => i + 1)
      load(c, { force: true })
    }
  }

  // 前ページ。1 ページ目で押されたら no-op。
  const prev = (): void => {
    if (pageIdx === 0 || loading) return
    const newIdx = pageIdx - 1
    setPageIdx(newIdx)
    load(history[newIdx])
  }

  // 訪問済みページへのジャンプ。S3 は前方向 cursor のみなので、
  // history に積まれていないページにはこの API では飛べない。
  const goto = (idx: number): void => {
    if (idx < 0 || idx >= history.length || idx === pageIdx || loading) return
    setPageIdx(idx)
    load(history[idx])
  }

  // 当該ディレクトリ全体のキャッシュを破棄して 1 ページ目から再 fetch。
  // 別ユーザがアップロード / 削除した直後に押す想定。検索中でも
  // 同じ prefix で前方一致 invalidate されるので search 結果も新鮮になる。
  const forceRefresh = (): void => {
    api.invalidateList(connId, bucket, prefix)
    setHistory([{}])
    setPageIdx(0)
    load({})
  }

  const dirs = page?.directories ?? []
  const files = page?.files ?? []
  // hasNext は「次がある」だけでなく「server が cursor を進めるか」も判定する。
  // DDN/MDX 互換 S3 は IsTruncated=true でも ContinuationToken / 最終キーが
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
  // 訪問済み最終ページか (= history を伸ばし得るのはここでだけ)。
  // この pageIdx より先にも未訪問のページが続くなら "+" を付けて示す。
  const isTrailingPage = pageIdx === history.length - 1
  const totalLabel = isTrailingPage && hasNext
    ? `${pageIdx + 1} / ${history.length}+`
    : `${pageIdx + 1} / ${history.length}`

  return (
    <div>
      {/* ── 検索 input + 再帰チェック ─────────────────────────
          再帰オフ: 現ディレクトリ "直下" の前方一致 (Delimiter='/')。
          再帰オン: prefix 配下を全て flat に列挙 (Delimiter なし)、
                  検索クエリ空でもサブディレクトリ全件を一覧できる便利モード。 */}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <input
          type="search"
          className={
            'flex-1 max-w-[480px] rounded-1 bg-paper px-3 py-1.5 text-[13px] ' +
            'transition-[border-color,box-shadow] focus:outline-none'
          }
          style={{
            border: '1px solid var(--color-rule-strong)',
            fontFamily: 'var(--font-sans)',
          }}
          placeholder={recursive
            ? 'このディレクトリ配下を検索 (前方一致・再帰)'
            : 'このディレクトリ内を検索 (前方一致)'}
          value={q}
          onChange={e => setQ(e.target.value)}
          aria-label="ディレクトリ内検索"
        />
        <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-ink-9">
          <input
            type="checkbox"
            checked={recursive}
            onChange={e => setRecursive(e.target.checked)}
          />
          <span className="select-none">再帰検索</span>
        </label>
        {isSearching && (
          <button
            type="button"
            onClick={() => setQ('')}
            className={
              'cursor-pointer rounded-1 bg-paper px-2 py-1 text-[11px] ' +
              'font-semibold uppercase tracking-[0.16em] text-ink-7 ' +
              'transition-colors hover:bg-ink-1 hover:text-ink-11'
            }
            style={{ border: '1px solid var(--color-rule-strong)' }}
            aria-label="検索をクリア"
          >
            clear
          </button>
        )}
      </div>

      {/* 進捗バー領域: 高さ 2px を常時確保しレイアウトシフトを避ける。
          loading (1 chunk 目) のときだけバー要素を描画する。loadingMore は
          下のセンチネル横に小さな indicator を出すので兼用しない。 */}
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
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr style={{ borderBottom: '1px solid var(--color-rule-strong)' }}>
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
          <p className="py-6 text-center text-[13px] text-ink-7">
            {isSearching
              ? `「${submittedQ}」に一致するエントリはありません${recursive ? ' (再帰)' : ''}。`
              : recursive
              ? 'このディレクトリ配下にエントリがありません。'
              : '空のディレクトリです。'}
          </p>
        )}

        {/* ── ページャ ───────────────────────────────────────
            戻る / 訪問済みページ番号 / 次 / 再読み込み を一列に並べる。
            S3 は前方向 cursor しか返さないので任意ページジャンプは「訪問済み」
            のみ。先に進むときは「次」ボタンで 1 ページずつ history を伸ばす。 */}
        <nav
          className="flex flex-wrap items-center justify-center gap-1.5 py-3"
          aria-label="ページ送り"
        >
          <button
            type="button"
            onClick={prev}
            disabled={pageIdx === 0 || loading}
            className={
              'cursor-pointer rounded-1 bg-paper px-2.5 py-1 text-[11.5px] text-ink-9 ' +
              'transition-colors hover:bg-ink-1 hover:text-ink-11 ' +
              'disabled:cursor-default disabled:opacity-40'
            }
            style={{ border: '1px solid var(--color-rule-strong)' }}
            aria-label="前のページへ"
          >
            ← 戻る
          </button>

          {history.map((_, i) => {
            const current = i === pageIdx
            return (
              <button
                key={i}
                type="button"
                onClick={() => goto(i)}
                disabled={loading || current}
                aria-current={current ? 'page' : undefined}
                className={
                  'cursor-pointer rounded-1 px-2.5 py-1 text-[11.5px] tabular-nums ' +
                  'transition-colors disabled:cursor-default ' +
                  (current
                    ? 'bg-ink-12 text-paper'
                    : 'bg-paper text-ink-9 hover:bg-ink-1 hover:text-ink-11 disabled:opacity-40')
                }
                style={{ border: '1px solid var(--color-rule-strong)' }}
              >
                {i + 1}
              </button>
            )
          })}

          <button
            type="button"
            onClick={next}
            disabled={!hasNext || loading}
            className={
              'cursor-pointer rounded-1 bg-paper px-2.5 py-1 text-[11.5px] text-ink-9 ' +
              'transition-colors hover:bg-ink-1 hover:text-ink-11 ' +
              'disabled:cursor-default disabled:opacity-40'
            }
            style={{ border: '1px solid var(--color-rule-strong)' }}
            aria-label="次のページへ"
          >
            次 →
          </button>

          <button
            type="button"
            onClick={forceRefresh}
            disabled={loading}
            className={
              'cursor-pointer rounded-1 bg-paper px-2.5 py-1 ' +
              'transition-colors hover:bg-ink-1 disabled:cursor-default disabled:opacity-40'
            }
            style={{ border: '1px solid var(--color-rule-strong)' }}
            title="キャッシュを破棄して再読み込み"
            aria-label="再読み込み"
          >
            <span aria-hidden>↻</span>
          </button>
        </nav>

        {/* 件数 / 現ページ表示。空ディレクトリのときは件数を出さない。 */}
        <p
          className="text-center text-[11px] text-ink-7 tabular-nums"
          style={{ letterSpacing: '0.02em' }}
        >
          <span style={{ fontFamily: 'var(--font-mono)' }}>ページ {totalLabel}</span>
          {!isEmpty && (
            <>
              {' · '}
              <span style={{ fontFamily: 'var(--font-mono)' }}>
                {dirs.length + files.length} 件
              </span>
            </>
          )}
        </p>

        {/* server が IsTruncated=true なのに cursor を進めずに返してきた場合の案内。
            よくある原因は ListObjects v2 を理解しないサーバ (MDX 等) で、
            設定 → 接続 → ListObjects API バージョンを v1 に切り替えると直る。 */}
        {cursorStuck && (
          <p className="mt-1 text-center text-[11px] text-ink-7">
            次へ進めません — server が cursor を進めずに同じトークンを返しています。
            <br />
            設定の <strong>ListObjects API バージョン</strong>{' '}
            を <span className="font-mono">v1</span> に切り替えてみてください
            (MDX 等の V1 only サーバで起こります)。
          </p>
        )}
      </div>
    </div>
  )
}
