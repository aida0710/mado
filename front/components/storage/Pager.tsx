import { CacheMeta } from '../CacheMeta'

type Cursor = { continuation?: string; startAfter?: string }

interface Props {
  pageIdx: number
  history: Cursor[]
  hasNext: boolean
  cursorStuck: boolean
  loading: boolean
  isEmpty: boolean
  totalLabel: string
  entryCount: number
  /** このページのデータが S3 から取得された時刻。null = まだロードしてない / invalidate 直後。 */
  fetchedAt?: Date | null
  onPrev: () => void
  onNext: () => void
  onGoto: (idx: number) => void
  onRefresh: () => void
}

// ページャ + 件数表示 + cursor stuck 案内。
// 戻る / 訪問済みページ番号 / 次 / 再読み込み を一列に並べる。
// S3 は前方向 cursor しか返さないので任意ページジャンプは「訪問済み」のみ。
export function Pager({
  pageIdx, history, hasNext, cursorStuck, loading, isEmpty,
  totalLabel, entryCount, fetchedAt, onPrev, onNext, onGoto, onRefresh,
}: Props) {
  return (
    <>
      <nav
        className="flex flex-wrap items-center justify-center gap-1.5 py-3"
        aria-label="ページ送り"
      >
        <button
          type="button"
          onClick={onPrev}
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

        {history.map((cursor, i) => {
          const current = i === pageIdx
          // append-only history では continuation / startAfter のいずれかが
          // ページごとにユニーク。1 ページ目は cursor が空 ({}) なので sentinel。
          const key = cursor.continuation ?? cursor.startAfter ?? '__first'
          return (
            <button
              key={key}
              type="button"
              onClick={() => onGoto(i)}
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
          onClick={onNext}
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
          onClick={onRefresh}
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

      {/* 件数 / 現ページ表示。空ディレクトリのときは件数を出さない。
          最後にキャッシュ取得時刻を薄く添える。 */}
      <p
        className="text-center text-[11px] text-ink-7 tabular-nums"
        style={{ letterSpacing: '0.02em' }}
      >
        <span style={{ fontFamily: 'var(--font-mono)' }}>ページ {totalLabel}</span>
        {!isEmpty && (
          <>
            {' · '}
            <span style={{ fontFamily: 'var(--font-mono)' }}>
              {entryCount} 件
            </span>
          </>
        )}
        {fetchedAt && (
          <>
            {' · '}
            <CacheMeta fetchedAt={fetchedAt} />
          </>
        )}
      </p>

      {/* server が IsTruncated=true なのに cursor を進めずに返してきた場合の案内。
          よくある原因は ListObjects v2 を理解しないサーバ
          (DDN 製のオブジェクトストレージ等) で、設定 → 接続 →
          ListObjects API バージョンを v1 に切り替えると直る。 */}
      {cursorStuck && (
        <p className="mt-1 text-center text-[11px] text-ink-7">
          次へ進めません: server が cursor を進めずに同じトークンを返しています。
          <br />
          設定の <strong>ListObjects API バージョン</strong>{' '}
          を <span className="font-mono">v1</span> に切り替えてみてください
          (DDN 製のオブジェクトストレージ等、V1 only サーバで起こります)。
        </p>
      )}
    </>
  )
}
