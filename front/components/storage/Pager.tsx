import { ChevronLeft, ChevronRight } from 'lucide-react'

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
  onPrev: () => void
  onNext: () => void
  onGoto: (idx: number) => void
}

// 表の下の帯 (.table-footer): 左に現ページと件数、右に 前 / 訪問済みのページ番号 / 次。
// 再読み込みは表の上の CacheBanner が持つ (取得時刻と同じ場所に集約)。
// S3 は前方向 cursor しか返さないので任意ページジャンプは「訪問済み」のみ。
export function Pager({
  pageIdx, history, hasNext, cursorStuck, loading, isEmpty,
  totalLabel, entryCount, onPrev, onNext, onGoto,
}: Props) {
  return (
    <>
      <div className="table-footer storage-pager">
        {/* 空のディレクトリのときは件数を出さない。 */}
        <span className="storage-pager-summary">
          ページ {totalLabel}
          {!isEmpty && ` · ${entryCount} 件`}
        </span>
        <nav className="storage-pager-nav" aria-label="ページ送り">
          <button
            type="button"
            className="icon-button"
            onClick={onPrev}
            disabled={pageIdx === 0 || loading}
            aria-label="前のページへ"
            title="前のページへ"
          >
            <ChevronLeft size={16} aria-hidden="true" />
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
                className="storage-pager-page"
                onClick={() => onGoto(i)}
                disabled={loading || current}
                aria-current={current ? 'page' : undefined}
              >
                {i + 1}
              </button>
            )
          })}

          <button
            type="button"
            className="icon-button"
            onClick={onNext}
            disabled={!hasNext || loading}
            aria-label="次のページへ"
            title="次のページへ"
          >
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </nav>
      </div>

      {/* server が IsTruncated=true なのに cursor を進めずに返してきた場合の案内。
          よくある原因は ListObjects v2 を理解しないサーバ
          (V1 only の S3 互換実装) で、設定 → 接続 →
          ListObjects API バージョンを v1 に切り替えると直る。 */}
      {cursorStuck && (
        <p className="notice storage-warning">
          <span>
            次へ進めません: server が cursor を進めずに同じトークンを返しています。
            設定の <strong>ListObjects API バージョン</strong>{' '}
            を <span className="mono">v1</span> に切り替えてみてください
            (V1 only の S3 互換サーバで起こります)。
          </span>
        </p>
      )}
    </>
  )
}
