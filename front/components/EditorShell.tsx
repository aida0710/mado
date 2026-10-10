// 編集ページ (NoteEditPage / ReadmeEditPage) の共通レイアウト + 動作。
//
// - 上部: ページの見出し (h1) と、何を編集しているかの補足
// - 中央: 枠の中に「左サイドバー (optional) + Monaco エディタ」 — leftPane が undefined のときは
//   1-pane (エディタのみ全幅)、指定されたときは 2-pane。900px 未満は縦に積み、
//   サイドバーは開閉ボタンで出す
// - 下部: エラー表示 + アカウント署名 (認証時はread-only) + キャンセル/保存
//
// 離脱警告:
//   - dirty (= 本文、または認証無効時の編集者名が変わった) のとき、ブラウザ閉じ・リロード時に
//     beforeunload 警告を出す
//   - 同サイト内のクライアントナビゲーション (Link 押下、戻る/進む) も React Router の
//     useBlocker で confirm ダイアログを挟む
//   - 保存成功直後は justSavedRef で 1 度だけ素通しさせる (保存→ホーム遷移を阻害しない)

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronUp, Folder } from 'lucide-react'
import { getEditorName, setEditorName } from '../lib/editorName'
import { useAuth } from '../lib/auth-context'
import { useBlocker } from 'react-router-dom'

interface Props {
  title: string
  /** 見出しの下の補足 (何を編集しているか。README なら場所)。 */
  description?: ReactNode
  initialBody: string
  onSave: (body: string, editor: string) => Promise<void>
  onSaved: () => void
  onCancel: () => void
  leftPane?: ReactNode
  /** 子要素: body の state を受け取って Monaco を描画する render-prop 形式。 */
  children: (api: { body: string; setBody: (v: string) => void }) => ReactNode
}

/** 編集ページの見出し。読み込み中や取得の失敗で EditorShell を出せない間も、同じ見出しを出すのに使う。 */
export function EditorPageHeader({ title, description }: { title: string; description?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {description && <p className="page-description">{description}</p>}
      </div>
    </header>
  )
}

export function EditorShell({
  title, description, initialBody,
  onSave, onSaved, onCancel,
  leftPane, children,
}: Props) {
  const auth = useAuth()
  const [body, setBody] = useState(() => initialBody)
  // 認証時はアカウント署名が正本。認証disabledの開発環境だけ従来の端末署名を使う。
  const [localEditor, setLocalEditor] = useState(() => getEditorName())
  const editor = auth.user?.signatureName ?? localEditor
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

  // 署名欄の初期値は自分の名前なので、editor の比較は「開いた時点の値」と行う。
  // initialEditor (前回の編集者) と比べると、開いただけで dirty になってしまう。
  const [openedEditor] = useState(editor)
  const dirty = body !== initialBody || (!auth.enabled && editor !== openedEditor)

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
      if (!auth.enabled) setEditorName(editor)
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
      <EditorPageHeader title={title} description={description} />

      <div className="editpage__frame">
        {/* サイドバーの開閉は 900px 未満でだけ見える (CSS)。leftPane が無いノート編集では出さない。 */}
        {leftPane && (
          <button
            type="button"
            className="editpage__sidebar-toggle"
            onClick={() => setSidebarOpen(o => !o)}
            aria-expanded={sidebarOpen}
            aria-controls="editpage-sidebar"
          >
            <Folder size={14} aria-hidden="true" />
            {sidebarOpen ? '閉じる' : 'ファイル参照'}
            {sidebarOpen ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
          </button>
        )}
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
      </div>

      {error && <p className="notice error editpage__error" role="alert">{error}</p>}
      <footer className="editpage__bar">
        <label className="field editpage__name">
          <span>編集者名</span>
          <input
            value={editor}
            onChange={e => setLocalEditor(e.target.value)}
            readOnly={auth.enabled}
            placeholder="e.g. tanaka"
            autoComplete="nickname"
            spellCheck={false}
            aria-label="編集者名"
          />
        </label>
        <div className="editpage__actions">
          <button type="button" onClick={handleCancel} disabled={saving} className="button">
            キャンセル
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving || !editor}
            className="button primary"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </footer>
    </section>
  )
}
