import type { ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'
import { Check } from 'lucide-react'
import { fmtDateTime, fmtSize } from '../lib/format'
import { useHistoryVersions, type HistorySource } from '../lib/useHistoryVersions'
import { Dialog } from './Dialog'

interface Props extends HistorySource {
  /** 見出しの下の小さな補足。履歴の対象 (ノートの名前や README の場所) を示す。 */
  subtitle: ReactNode
  titleId: string
  /** 何の履歴か ("README の履歴" など)。 */
  title: ReactNode
  /** 現在の本文。一致する版に「現在と一致」の注記を出す。null = 現在は本文なし。 */
  currentBody: string | null
  onClose: () => void
}

/** 編集履歴のダイアログ。左に版の一覧、右に選んだ版の Markdown を表示する。
 *  README と Team note で取得元だけが違うので、それは HistorySource で受け取る。 */
export function HistoryModal({
  subtitle, titleId, title, currentBody, onClose, loadVersions, loadVersion,
}: Props) {
  const { state, selectVersion } = useHistoryVersions({ loadVersions, loadVersion })
  const { versions, error, selectedId, selectedBody } = state

  return (
    <Dialog
      titleId={titleId}
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      closeLabel="履歴を閉じる"
      size="extra-wide"
    >
      <div className="dialog-body">
        {error && <p className="notice error">{error}</p>}
        {!error && versions === null && <p className="state-message">読み込み中…</p>}
        {!error && versions !== null && versions.length === 0 && (
          <p className="state-message">履歴はありません。</p>
        )}

        {versions !== null && versions.length > 0 && (
          <div className="history-layout">
            <ul className="history-versions">
              {versions.map((version, index) => (
                <li key={version.id}>
                  <button
                    type="button"
                    className="history-version"
                    aria-current={selectedId === version.id ? 'true' : undefined}
                    onClick={() => selectVersion(version.id)}
                  >
                    <span className="history-version__editor">
                      {version.editor}
                      {index === 0 && <span className="status-badge history-latest">最新</span>}
                    </span>
                    <span className="muted">
                      {fmtDateTime(version.edited_at)} · {fmtSize(version.size_bytes)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="history-preview">
              {selectedBody === null ? (
                <p className="state-message">読み込み中…</p>
              ) : (
                <>
                  {currentBody !== null && selectedBody.body === currentBody && (
                    <p className="notice history-match">
                      <Check size={14} aria-hidden="true" />
                      <span>この版は現在の本文と一致します。</span>
                    </p>
                  )}
                  <div className="markdown-body">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      rehypePlugins={[rehypeSanitize]}
                    >
                      {selectedBody.body}
                    </ReactMarkdown>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </Dialog>
  )
}
