import { lazy, Suspense, useState } from 'react'
import { Link } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'
import { History, Pencil } from 'lucide-react'
import { api } from '../lib/api/client'
import { useRetryableLoad } from '../lib/useRetryableLoad'
import { LoadFailedNotice } from '../components/LoadFailedNotice'

// 履歴モーダルはボタンを押した後にだけ描画する。React.lazy() で別チャンクへ。
const NoteHistoryModal = lazy(() =>
  import('../components/NoteHistoryModal').then(m => ({ default: m.NoteHistoryModal })),
)

const loadHomeNote = () => api.note('home')

function formatEditedAt(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('ja-JP', {
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

// 最後に編集した人と日時を、見出しの下の一行にする。片方しか無ければある方だけで書く。
function lastEditedSummary(editor: string | null, when: string | null): string | null {
  if (editor && when) return `${editor}が${when}に更新`
  if (editor) return `${editor}が更新`
  if (when) return `${when}に更新`
  return null
}

export default function HomePage() {
  const { state, retry } = useRetryableLoad(loadHomeNote)
  const [historyOpen, setHistoryOpen] = useState(false)

  if (state.status === 'loading') return null
  if (state.status === 'failed') {
    // 読み込めないときは「まだ何も書かれていません」や作成の導線を出さない。
    // 既存のノートがあるのに作成から書き始めると、保存で上書きしてしまうため。
    return (
      <>
        <header className="page-header">
          <div>
            <h1>Team note</h1>
          </div>
        </header>
        <LoadFailedNotice subject="Team note" reason={state.reason} onRetry={retry} />
      </>
    )
  }
  const data = state.value

  const summary = data.exists
    ? lastEditedSummary(
        data.last_editor || null,
        data.last_edited_at ? formatEditedAt(data.last_edited_at) || null : null,
      )
    : null
  const isPresent = data.exists && data.body.trim().length > 0

  return (
    <>
      <header className="page-header">
        <div>
          <h1>Team note</h1>
          {summary && <p className="page-description">{summary}</p>}
        </div>
        <div className="page-actions">
          <Link className="button" to="/edit-note">
            <Pencil size={15} aria-hidden="true" />
            {data.exists ? '編集' : '作成'}
          </Link>
          <button
            type="button"
            className="button"
            onClick={() => setHistoryOpen(true)}
            title="編集履歴を表示"
          >
            <History size={15} aria-hidden="true" />
            履歴
          </button>
        </div>
      </header>

      {isPresent ? (
        <div className="markdown-body home-note">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeSanitize]}
          >
            {data.body}
          </ReactMarkdown>
        </div>
      ) : (
        <div className="empty-state">
          <h2>まだ何も書かれていません</h2>
          <p>メンバー全員で同じノートを書き足していきます。例:</p>
          <ul>
            <li>他アプリケーションの情報</li>
            <li>ストレージ接続まわりの補足 (どこに何があるか)</li>
          </ul>
          <Link className="button primary" to="/edit-note">
            <Pencil size={15} aria-hidden="true" />
            最初のノートを書く
          </Link>
        </div>
      )}

      {historyOpen && (
        <Suspense fallback={null}>
          <NoteHistoryModal
            slug="home"
            currentBody={data.exists ? data.body : null}
            onClose={() => setHistoryOpen(false)}
          />
        </Suspense>
      )}
    </>
  )
}
