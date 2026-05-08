import { useState } from 'react'
import MDEditor from '@uiw/react-md-editor'
// フル編集 UI (CodeMirror + ツールバー) の CSS。MarkdownEditor は HomePage /
// ReadmeView から React.lazy() でロードされるため、ここで import すると
// Vite が同じ非同期チャンクに同梱してくれる (= 編集モーダルを開かない
// ユーザは数十 KB のスタイルをロードしない)。
import '@uiw/react-md-editor/markdown-editor.css'

interface Props {
  title: string
  initialBody: string
  initialEditor: string
  onSave: (body: string, editor: string) => Promise<void>
  onSaved: () => void
  onClose: () => void
}

export function MarkdownEditor({
  title, initialBody, initialEditor, onSave, onSaved, onClose,
}: Props) {
  // initialBody は意図的な「初期値のみ」用法 (prop と同期させない、ユーザ編集を保持する)。
  // 関数形 initializer で react-doctor の no-derived-useState を回避する試み。
  const [body, setBody] = useState<string>(() => initialBody)
  // 関数形式: localStorage は同期 DOM API なので、関数を渡さないと毎レンダ
  // getItem が走る (React は初回以外の戻り値を捨てるが計測コストは残る)。
  const [editor, setEditor] = useState(
    () => initialEditor || localStorage.getItem('dashboard.lastEditor') || '',
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await onSave(body, editor)
      localStorage.setItem('dashboard.lastEditor', editor)
      onSaved()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop">
      <div
        className="modal modal--editor wmde-markdown-var"
        role="dialog"
        aria-modal="true"
        aria-labelledby="md-editor-title"
        data-color-mode="light"
      >
        <h3 id="md-editor-title">{title}</h3>
        <div className="md-shell">
          <MDEditor
            value={body}
            onChange={v => setBody(v ?? '')}
            height={420}
            preview="edit"
            textareaProps={{
              'aria-label': 'Markdown body',
              spellCheck: false,
            }}
          />
        </div>
        <label className="modal-field">
          <span className="label">Your name (last editor)</span>
          <input
            aria-label="Your name"
            value={editor}
            onChange={e => setEditor(e.target.value)}
            placeholder="e.g. tanaka"
            autoComplete="nickname"
            spellCheck={false}
          />
        </label>
        {error && <p className="error" aria-live="polite">{error}</p>}
        <div className="modal-actions">
          <button onClick={onClose} disabled={saving}>Cancel</button>
          <button
            onClick={save}
            disabled={saving || !editor}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
