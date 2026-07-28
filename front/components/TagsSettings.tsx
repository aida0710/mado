import { useEffect, useReducer } from 'react'
import { api } from '../lib/api/client'
import type { Tag } from '../lib/api/types'
import { TagBadge } from './TagBadge'
import { ImportExportButtons } from './ImportExportButtons'
import { downloadJson, type ImportMode, type ImportSummary } from '../lib/jsonFile'

// エクスポート形式。id は書き出さない — インポート先で採番するため
// (id は nanoid で、環境をまたいで意味を持たない)。同一性は name で見る。
interface TagsExport {
  mado: 'tags'
  version: 1
  tags: Array<{ name: string; color: string }>
}

const sectionTitleClass =
  'm-0 text-[10.5px] font-semibold uppercase tracking-[0.22em] text-ink-7'

interface State {
  tags: Tag[]
  loading: boolean
  error: string | null
  adding: boolean
  editing: Tag | null
  deleting: Tag | null
}

type Action =
  | { type: 'loadOk'; tags: Tag[] }
  | { type: 'loadErr'; error: string }
  | { type: 'openAdd' }
  | { type: 'openEdit'; tag: Tag }
  | { type: 'openDelete'; tag: Tag }
  | { type: 'closeModal' }

const initial: State = { tags: [], loading: true, error: null, adding: false, editing: null, deleting: null }

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'loadOk':    return { ...s, loading: false, tags: a.tags }
    case 'loadErr':   return { ...s, loading: false, error: a.error }
    case 'openAdd':   return { ...s, adding: true }
    case 'openEdit':  return { ...s, editing: a.tag }
    case 'openDelete':return { ...s, deleting: a.tag }
    case 'closeModal':return { ...s, adding: false, editing: null, deleting: null }
  }
}

// 新規作成・編集共通の小さいインラインフォーム (2 フィールドのみなので
// ConnectionForm のような別ファイルには分けない)。
function TagForm({
  initialValue, onSubmit, onCancel,
}: {
  initialValue: { name: string; color: string }
  onSubmit: (v: { name: string; color: string }) => Promise<void>
  onCancel: () => void
}) {
  const [name, setName] = useReducer((_: string, v: string) => v, initialValue.name)
  const [color, setColor] = useReducer((_: string, v: string) => v, initialValue.color)
  const [saving, setSaving] = useReducer((_: boolean, v: boolean) => v, false)
  const [error, setError] = useReducer((_: string | null, v: string | null) => v, null)

  const submit = async () => {
    if (!name.trim()) { setError('名前を入力してください'); return }
    setSaving(true)
    setError(null)
    try {
      await onSubmit({ name: name.trim(), color })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal modal--narrow" role="dialog" aria-modal="true" aria-labelledby="tag-form-title">
        <p className="kicker">Settings · タグ</p>
        <h3 id="tag-form-title">{initialValue.name ? 'タグを編集' : 'タグを追加'}</h3>
        <label className="modal-field">
          <span className="label">名前</span>
          <input value={name} onChange={e => setName(e.target.value)} autoComplete="off" spellCheck={false} />
        </label>
        <label className="modal-field">
          <span className="label">色</span>
          <input type="color" value={color} onChange={e => setColor(e.target.value)} />
        </label>
        {error && <p className="error" aria-live="polite">{error}</p>}
        <div className="modal-actions">
          <button onClick={onCancel} disabled={saving}>キャンセル</button>
          <button onClick={submit} disabled={saving}>{saving ? '保存中…' : '保存'}</button>
        </div>
      </div>
    </div>
  )
}

function DeleteConfirm({
  tag, onConfirm, onCancel,
}: { tag: Tag; onConfirm: () => Promise<void>; onCancel: () => void }) {
  const [busy, setBusy] = useReducer((_: boolean, v: boolean) => v, false)
  const [error, setError] = useReducer((_: string | null, v: string | null) => v, null)
  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await onConfirm()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="modal-backdrop">
      <div className="modal modal--narrow" role="dialog" aria-modal="true" aria-labelledby="tag-delete-title">
        <p className="kicker">Settings · タグ · 削除</p>
        <h3 id="tag-delete-title">タグを削除</h3>
        <p className="text-[14px] leading-relaxed text-ink-9">
          タグ「{tag.name}」を削除します。全ての割り当ても消えます。よろしいですか?
        </p>
        {error && <p className="error" aria-live="polite">{error}</p>}
        <div className="modal-actions">
          <button onClick={onCancel} disabled={busy}>キャンセル</button>
          <button
            onClick={submit}
            disabled={busy}
            style={{ background: 'var(--danger)', borderColor: 'var(--danger)', color: 'var(--paper)' }}
          >
            {busy ? '削除中…' : '削除'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function TagsSettings() {
  const [state, dispatch] = useReducer(reducer, initial)
  const { tags, loading, error, adding, editing, deleting } = state

  const refresh = () => {
    api.tags().then(tags => dispatch({ type: 'loadOk', tags })).catch((e: Error) => dispatch({ type: 'loadErr', error: e.message }))
  }
  useEffect(() => { refresh() }, [])

  const handleExport = () => {
    const body: TagsExport = {
      mado: 'tags',
      version: 1,
      tags: tags.map(t => ({ name: t.name, color: t.color })),
    }
    downloadJson('mado-tags.json', body)
  }

  // 同名のタグは作り直さずスキップする (名前が UNIQUE で、色だけ違う場合に
  // 上書きすると既存の割り当ての見た目が黙って変わるため)。
  const handleImport = async (data: unknown, mode: ImportMode): Promise<ImportSummary> => {
    const d = data as Partial<TagsExport>
    if (d?.mado !== 'tags' || !Array.isArray(d.tags)) {
      throw new Error('mado のタグのエクスポートファイルではありません。')
    }
    const existing = new Set(tags.map(t => t.name))
    const summary: ImportSummary = { added: 0, skipped: 0, removed: 0, failed: [] }

    // 置き換え = 同期。ファイルに無いタグを消す。
    // タグを消すと storage_tag_assignments の CASCADE でそのタグの割り当ても
    // 一緒に消える (呼び出し側で警告を出している)。
    if (mode === 'replace') {
      const wanted = new Set(d.tags.map(t => t?.name).filter((n): n is string => typeof n === 'string'))
      for (const t of tags) {
        if (wanted.has(t.name)) continue
        try {
          await api.deleteTag(t.id)
          summary.removed = (summary.removed ?? 0) + 1
          existing.delete(t.name)
        } catch (e) {
          summary.failed.push(`${t.name}: ${(e as Error).message}`)
        }
      }
    }
    for (const t of d.tags) {
      if (typeof t?.name !== 'string' || typeof t?.color !== 'string') {
        summary.failed.push('name / color が文字列でない項目があります')
        continue
      }
      if (existing.has(t.name)) { summary.skipped++; continue }
      try {
        await api.createTag({ name: t.name, color: t.color })
        existing.add(t.name)
        summary.added++
      } catch (e) {
        summary.failed.push(`${t.name}: ${(e as Error).message}`)
      }
    }
    return summary
  }

  return (
    <section className="mt-7">
      <div
        className="mb-3 flex flex-wrap items-baseline justify-between gap-3 pb-2"
        style={{ borderBottom: '1px solid var(--rule)' }}
      >
        <h3 className={sectionTitleClass}>タグの管理</h3>
        <span className="inline-flex flex-wrap items-center gap-2">
          <ImportExportButtons
            what="タグ"
            replaceWarning="削除されるタグに付いていた割り当ては、まとめて外れます (tag_id の連鎖削除)。"
            onExport={handleExport}
            onImport={handleImport}
            onDone={refresh}
          />
          <button className="ghost" onClick={() => dispatch({ type: 'openAdd' })}>
            <span aria-hidden>+</span> 追加
          </button>
        </span>
      </div>

      {loading && <p className="text-[13px] text-ink-7">読み込み中…</p>}
      {error && <p className="error">{error}</p>}

      {!loading && tags.length === 0 && (
        <p className="text-[13px] text-ink-7">まだタグがありません。</p>
      )}

      {tags.length > 0 && (
        <ul className="m-0 list-none p-0">
          {tags.map(tag => (
            <li
              key={tag.id}
              className="flex items-center justify-between gap-3 py-2.5"
              style={{ borderBottom: '1px solid var(--rule)' }}
            >
              <TagBadge tag={tag} />
              <span className="flex gap-2">
                <button className="ghost" onClick={() => dispatch({ type: 'openEdit', tag })}>編集</button>
                <button
                  className="ghost"
                  aria-label={`${tag.name} を削除`}
                  onClick={() => dispatch({ type: 'openDelete', tag })}
                >
                  削除
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {adding && (
        <TagForm
          initialValue={{ name: '', color: '#888888' }}
          onSubmit={async v => { await api.createTag(v); dispatch({ type: 'closeModal' }); refresh() }}
          onCancel={() => dispatch({ type: 'closeModal' })}
        />
      )}
      {editing && (
        <TagForm
          initialValue={{ name: editing.name, color: editing.color }}
          onSubmit={async v => { await api.updateTag(editing.id, v); dispatch({ type: 'closeModal' }); refresh() }}
          onCancel={() => dispatch({ type: 'closeModal' })}
        />
      )}
      {deleting && (
        <DeleteConfirm
          tag={deleting}
          onConfirm={async () => { await api.deleteTag(deleting.id); dispatch({ type: 'closeModal' }); refresh() }}
          onCancel={() => dispatch({ type: 'closeModal' })}
        />
      )}
    </section>
  )
}
