// `/edit-note` — ホームの Team note (slug='home') を Monaco で編集する 1-pane ページ。
//
// HomePage.tsx の「編集」 / 「作成」ボタンから <Link to="/edit-note"> で遷移してくる。
// 保存後は navigate('/') でホームに戻る。ホームを開き直すと useRetryableLoad が取り直すので、
// 明示的な refresh コールは不要。

import { useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api/client'
import { useRetryableLoad } from '../lib/useRetryableLoad'
import { EditorPageHeader, EditorShell } from '../components/EditorShell'
import { LoadFailedNotice } from '../components/LoadFailedNotice'
import {
  MonacoMarkdownEditor,
  type MonacoMarkdownEditorHandle,
} from '../components/MonacoMarkdownEditor'

const loadHomeNote = () => api.note('home')

const TITLE = 'ノートを編集'
const DESCRIPTION = 'Team note'

export default function NoteEditPage() {
  const navigate = useNavigate()
  const { state, retry } = useRetryableLoad(loadHomeNote)
  const editorRef = useRef<MonacoMarkdownEditorHandle>(null)

  if (state.status === 'loading') {
    return (
      <>
        <EditorPageHeader title={TITLE} description={DESCRIPTION} />
        <p className="state-message">読み込み中…</p>
      </>
    )
  }
  if (state.status === 'failed') {
    return (
      <>
        <EditorPageHeader title={TITLE} description={DESCRIPTION} />
        <LoadFailedNotice subject="Team note" reason={state.reason} onRetry={retry}>
          既存の本文を上書きしないよう、読み込めるまで編集できません。
        </LoadFailedNotice>
      </>
    )
  }
  const data = state.value

  const goHome = () => navigate('/')

  return (
    <EditorShell
      title={TITLE}
      description={DESCRIPTION}
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
