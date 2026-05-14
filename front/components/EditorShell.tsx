// 編集ページ (NoteEditPage / ReadmeEditPage) の共通レイアウト + 動作。
//
// - 上部: kicker + h2 (タイトル)
// - 中央: 「左サイドバー (optional) + Monaco エディタ」 — leftPane が undefined のときは
//   1-pane (エディタのみ全幅)、指定されたときは 2-pane
// - 下部: 編集者名 input + 保存/キャンセル ボタン + エラー表示
//
// 離脱警告:
//   - dirty (= 本文 or 編集者名が初期値から変わった) のとき、ブラウザ閉じ・リロード時に
//     beforeunload 警告を出す
//   - 同サイト内のクライアントナビゲーション (Link 押下、戻る/進む) も React Router の
//     useBlocker で confirm ダイアログを挟む
//   - 保存成功直後は justSavedRef で 1 度だけ素通しさせる (保存→ホーム遷移を阻害しない)

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useBlocker } from 'react-router-dom'

interface Props {
  kicker?: string
  title: string
  initialBody: string
  initialEditor: string
  onSave: (body: string, editor: string) => Promise<void>
  onSaved: () => void
  onCancel: () => void
  leftPane?: ReactNode
  /** 子要素: body の state を受け取って Monaco を描画する render-prop 形式。 */
  children: (api: { body: string; setBody: (v: string) => void }) => ReactNode
}

export function EditorShell({
  kicker, title, initialBody, initialEditor,
  onSave, onSaved, onCancel,
  leftPane, children,
}: Props) {
  const [body, setBody] = useState(() => initialBody)
  const [editor, setEditor] = useState(
    () => initialEditor || localStorage.getItem('dashboard.lastEditor') || '',
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // モバイル時の sidebar (= ファイル参照ペイン) の開閉。デスクトップでは CSS により
  // この state は無視され、常時表示になる。leftPane が無い (note 編集) ページでは
  // そもそも toggle ボタンが出ない。
  const [sidebarOpen, setSidebarOpen] = useState(false)
  // 「保存直後の onSaved → navigate」 を useBlocker で阻害しないためのフラグ。
  // useState だと state 更新が次レンダーまで反映されず blocker 関数のクロージャに
  // 古い値が残るので、ref で同期更新する。
  const justSavedRef = useRef(false)

  const dirty = body !== initialBody || editor !== initialEditor

  // 1. ブラウザレベル離脱 (タブ閉じ / リロード / 外部 URL 遷移)
  useEffect(() => {
    if (!dirty) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      // Chrome 等は returnValue を空文字でセットすると標準警告を出す
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

  // 2. クライアント側ナビゲーション (Link 押下、戻る/進む) を React Router で堰き止め
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (justSavedRef.current) return false
    return dirty && currentLocation.pathname !== nextLocation.pathname
  })

  useEffect(() => {
    if (blocker.state === 'blocked') {
      const ok = window.confirm('未保存の変更があります。本当に離れますか？')
      if (ok) blocker.proceed()
      else blocker.reset()
    }
  }, [blocker])

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await onSave(body, editor)
      localStorage.setItem('dashboard.lastEditor', editor)
      justSavedRef.current = true
      onSaved()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const handleCancel = () => {
    if (dirty && !window.confirm('未保存の変更があります。本当に離れますか？')) return
    justSavedRef.current = true  // confirm 済みなので blocker は素通し
    onCancel()
  }

  return (
    <section className={leftPane ? 'editpage editpage--two-pane' : 'editpage'}>
      <header className="editpage__head">
        <div className="editpage__head-text">
          {kicker && <p className="kicker editpage__kicker">{kicker}</p>}
          <h2 className="editpage__title">{title}</h2>
        </div>
        {/* sidebar toggle はモバイルのみ (CSS で制御)。leftPane が無いノート編集では出さない。 */}
        {leftPane && (
          <button
            type="button"
            className="editpage__sidebar-toggle ghost"
            onClick={() => setSidebarOpen(o => !o)}
            aria-expanded={sidebarOpen}
            aria-controls="editpage-sidebar"
          >
            <span aria-hidden>📁</span>
            {sidebarOpen ? '閉じる' : 'ファイル参照'}
          </button>
        )}
      </header>

      <div className="editpage__body">
        {leftPane && (
          <aside
            id="editpage-sidebar"
            className="editpage__sidebar"
            data-mobile-open={sidebarOpen}
          >
            {leftPane}
          </aside>
        )}
        <div className="editpage__editor-area">
          {children({ body, setBody })}
        </div>
      </div>

      <footer className="editpage__bar">
        <label className="editpage__name">
          <span className="label">編集者名</span>
          <input
            value={editor}
            onChange={e => setEditor(e.target.value)}
            placeholder="e.g. tanaka"
            autoComplete="nickname"
            spellCheck={false}
            aria-label="編集者名"
          />
        </label>
        {error && <p className="editpage__error" aria-live="polite">{error}</p>}
        <div className="editpage__actions">
          <button onClick={handleCancel} disabled={saving} className="ghost">
            キャンセル
          </button>
          <button
            onClick={save}
            disabled={saving || !editor}
            className="editpage__save"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </footer>
    </section>
  )
}
