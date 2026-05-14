// `/edit-note` — ホームの Team note (slug='home') を Monaco で編集する 1-pane ページ。
//
// HomePage.tsx の「✎ 編集」 / 「✎ 作成」ボタンから <Link to="/edit-note"> で遷移してくる。
// 保存後は navigate('/') でホームに戻る。HomePage 側の useEffect が再フェッチを行うので
// 明示的な refresh コールは不要。

import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { z } from 'zod'
import { api } from '../lib/api/client'
import type { Note } from '../lib/api/types'
import { EditorShell } from '../components/EditorShell'
import {
  MonacoMarkdownEditor,
  type MonacoMarkdownEditorHandle,
} from '../components/MonacoMarkdownEditor'

type NoteData = z.infer<typeof Note>

export default function NoteEditPage() {
  const navigate = useNavigate()
  const [data, setData] = useState<NoteData | null>(null)
  const editorRef = useRef<MonacoMarkdownEditorHandle>(null)

  useEffect(() => {
    let cancelled = false
    api.note('home')
      .then(r => { if (!cancelled) setData(r) })
      .catch(() => { if (!cancelled) setData({ exists: false }) })
    return () => { cancelled = true }
  }, [])

  if (!data) return <p className="text-[13px] text-ink-7">読み込み中…</p>

  const goHome = () => navigate('/')

  return (
    <EditorShell
      kicker="Team note — edit"
      title="ノートを編集"
      initialBody={data.exists ? data.body : ''}
      initialEditor={data.exists && data.last_editor ? data.last_editor : ''}
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
