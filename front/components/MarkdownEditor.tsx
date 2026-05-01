import { useState } from 'react'
import MDEditor from '@uiw/react-md-editor'

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
  const [body, setBody] = useState(initialBody)
  const [editor, setEditor] = useState(
    initialEditor || localStorage.getItem('dashboard.lastEditor') || '',
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
        <label>
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
