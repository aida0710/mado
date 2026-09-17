import type { ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'
import { fmtDateTime, fmtSize } from '../lib/format'
import { useHistoryVersions, type HistorySource } from '../lib/useHistoryVersions'
import { ModalShell } from './ModalShell'

interface Props extends HistorySource {
  /** 見出し上の小さなラベル ("S3 README · 履歴" など)。何の履歴かを明示する。 */
  kicker: string
  titleId: string
  title: ReactNode
  /** 現在の本文。一致する版に「現在と一致」の注記を出す。null = 現在は本文なし。 */
  currentBody: string | null
  onClose: () => void
}

/** 編集履歴モーダル。左に版の一覧、右に選んだ版の Markdown を表示する。
 *  README と Team note で取得元だけが違うので、それは HistorySource で受け取る。 */
export function HistoryModal({
  kicker, titleId, title, currentBody, onClose, loadVersions, loadVersion,
}: Props) {
  const { state, selectVersion } = useHistoryVersions({ loadVersions, loadVersion })
  const { versions, error, selectedId, selectedBody } = state

  return (
    <ModalShell titleId={titleId} onClose={onClose} colorMode="light">
      <header className="flex items-baseline gap-3 pb-4 mb-2" style={{ borderBottom: '1px solid var(--rule)' }}>
        <div className="flex-1 min-w-0">
          <p className="kicker">{kicker}</p>
          <h3 id={titleId} className="m-0 truncate">
            {title}
          </h3>
        </div>
        <button
          type="button"
          className="ghost"
          onClick={onClose}
          aria-label="履歴を閉じる"
        >
          <span aria-hidden>✕</span>
        </button>
      </header>

      {error && <p className="error">{error}</p>}
      {!error && versions === null && (
        <p className="text-[13px] text-ink-7">loading…</p>
      )}
      {!error && versions !== null && versions.length === 0 && (
        <p className="text-[13px] text-ink-7">履歴はありません。</p>
      )}

      {versions !== null && versions.length > 0 && (
        <div className="grid gap-4 md:gap-5 grid-cols-1 md:[grid-template-columns:240px_1fr] min-h-[60vh]">
          <ul
            className="m-0 list-none overflow-auto p-0 max-h-[40vh] md:max-h-none border-b md:border-b-0 md:[border-right:1px_solid_var(--rule)]"
            style={{ borderColor: 'var(--rule)' }}
          >
            {versions.map((version, index) => {
              const selected = selectedId === version.id
              return (
                <li key={version.id} style={{ borderBottom: '1px solid var(--rule)' }}>
                  <button
                    type="button"
                    className={
                      'block w-full cursor-pointer border-0 bg-transparent py-2.5 pr-3 pl-3 text-left ' +
                      'transition-colors hover:bg-ink-0 ' +
                      (selected ? 'bg-ink-0 ' : '')
                    }
                    style={selected ? { borderLeft: '2px solid var(--ink-12)', paddingLeft: '10px' } : undefined}
                    onClick={() => selectVersion(version.id)}
                  >
                    <div className={'text-[13px] ' + (selected ? 'font-semibold text-ink-12' : 'font-medium text-ink-11')}>
                      {index === 0 && (
                        <span aria-label="latest" className="mr-1 text-ink-9">●</span>
                      )}
                      {version.editor}
                    </div>
                    <div
                      className="mt-0.5 text-[10.5px] text-ink-7 tabular-nums"
                      style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.02em' }}
                    >
                      {fmtDateTime(version.edited_at)} <span className="text-ink-3">·</span> {fmtSize(version.size_bytes)}
                    </div>
                  </button>
                </li>
              )
            })}
          </ul>
          <div className="overflow-auto">
            {selectedBody === null && (
              <p className="text-[13px] text-ink-7">loading…</p>
            )}
            {selectedBody !== null && (
              <>
                {currentBody !== null && selectedBody.body === currentBody && (
                  <p className="m-0 mb-3 text-[11.5px] text-ink-7">
                    この版は現在の本文と一致します。
                  </p>
                )}
                <article className="article">
                  <div className="markdown-body">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      rehypePlugins={[rehypeSanitize]}
                    >
                      {selectedBody.body}
                    </ReactMarkdown>
                  </div>
                </article>
              </>
            )}
          </div>
        </div>
      )}
    </ModalShell>
  )
}
