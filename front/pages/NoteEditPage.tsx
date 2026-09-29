// `/edit-note` — ホームの Team note (slug='home') を Monaco で編集する 1-pane ページ。
//
// HomePage.tsx の「✎ 編集」 / 「✎ 作成」ボタンから <Link to="/edit-note"> で遷移してくる。
// 保存後は navigate('/') でホームに戻る。ホームを開き直すと useRetryableLoad が取り直すので、
// 明示的な refresh コールは不要。

import { useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api/client'
import { useRetryableLoad } from '../lib/useRetryableLoad'
import { EditorShell } from '../components/EditorShell'
import { LoadFailedNotice } from '../components/LoadFailedNotice'
import {
  MonacoMarkdownEditor,
  type MonacoMarkdownEditorHandle,
} from '../components/MonacoMarkdownEditor'

const loadHomeNote = () => api.note('home')

export default function NoteEditPage() {
  const navigate = useNavigate()
  const { state, retry } = useRetryableLoad(loadHomeNote)
  const editorRef = useRef<MonacoMarkdownEditorHandle>(null)

  if (state.status === 'loading') return <p className="text-[13px] text-ink-7">読み込み中…</p>
  if (state.status === 'failed') {
    return (
      <LoadFailedNotice subject="Team note" reason={state.reason} onRetry={retry}>
        既存の本文を上書きしないよう、読み込めるまで編集できません。
      </LoadFailedNotice>
    )
  }
  const data = state.value

  const goHome = () => navigate('/')

  return (
    <EditorShell
      kicker="Team note — edit"
      title="ノートを編集"
      initialBody={data.exists ? data.body : ''}
      onSave={(body, editor) =>
        api.putNote('home', body, editor).then(() => undefined)
      }
      onSaved={goHome}
      onCancel={goHome}
    >
      {({ body, setBody }) => (
        <MonacoMarkdownEditor
          ref={editorRef}
          value={body}
          onChange={setBody}
          height="100%"
          ariaLabel="ノート本文 (Markdown)"
        />
      )}
    </EditorShell>
  )
}
