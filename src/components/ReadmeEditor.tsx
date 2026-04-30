import { useState } from 'react'
import { api } from '../api/client'

interface Props {
  bucket: string
  prefix: string
  initialBody: string
  initialEditor: string
  onClose: () => void
  onSaved: () => void
}

export function ReadmeEditor({
  bucket, prefix, initialBody, initialEditor, onClose, onSaved,
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
      await api.putReadme(bucket, prefix, body, editor)
      localStorage.setItem('dashboard.lastEditor', editor)
      onSaved()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
    >
      <div
        className="modal"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <h3>Edit README — {prefix || '(root)'}</h3>
        <label>
          <span className="label">README</span>
          <textarea
            aria-label="README"
            rows={16}
            value={body}
            onChange={e => setBody(e.target.value)}
          />
        </label>
        <label>
          <span className="label">Your name (last editor)</span>
          <input
            aria-label="Your name"
            value={editor}
            onChange={e => setEditor(e.target.value)}
            placeholder="e.g. tanaka"
          />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="modal-actions">
          <button onClick={onClose} disabled={saving}>Cancel</button>
          <button
            onClick={save}
            disabled={saving || !editor || !body}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
