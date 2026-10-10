// `/storage/:connectionId/edit-readme/:bucket/*` — 任意 prefix の README を Monaco で編集する
// 2-pane ページ。左ペインに「現在 prefix の直下のファイル/ディレクトリ」を出し、
// 行クリックで Monaco の現在カーソル位置に `[name](/storage/connection/bucket/path)` を挿入する。
//
// 保存後は元の StorageBucket ページに戻る。

import { useCallback, useRef } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../lib/api/client'
import { encPath } from '../lib/route'
import { useCapabilities } from '../lib/useCapabilities'
import { useRetryableLoad } from '../lib/useRetryableLoad'
import { EditorPageHeader, EditorShell } from '../components/EditorShell'
import { InsertableFileList, type InsertableEntry } from '../components/InsertableFileList'
import { LoadFailedNotice } from '../components/LoadFailedNotice'
import {
  MonacoMarkdownEditor,
  type MonacoMarkdownEditorHandle,
} from '../components/MonacoMarkdownEditor'

interface Props { connectionId: string }

export default function ReadmeEditPage({ connectionId }: Props) {
  // React Router v7 では splat は params['*'] で取れる。
  const params = useParams<{ bucket: string; '*': string }>()
  const bucket = params.bucket ?? ''
  // URL splat (例: 'docs/sub') を S3 prefix 形式 ('docs/sub/' or '') に正規化。
  const splat = params['*'] ?? ''
  const prefix = splat === '' ? '' : splat.endsWith('/') ? splat : splat + '/'

  const navigate = useNavigate()
  const caps = useCapabilities(connectionId)
  const editorRef = useRef<MonacoMarkdownEditorHandle>(null)

  const loadLatestReadme = useCallback(() => {
    // キャッシュ（最大 6 時間前）の本文から編集を始めると、その間にほかの人が保存した
    // 更新を、保存で黙って上書きしてしまう。編集の元は必ずサーバーから取り直す。
    api.invalidateReadme(connectionId, bucket, prefix)
    return api.readme({ connectionId, bucket, prefix })
  }, [connectionId, bucket, prefix])
  const { state, retry } = useRetryableLoad(bucket && caps.readmeWrite ? loadLatestReadme : null)

  if (!bucket) {
    return <p className="state-message">bucket がありません</p>
  }

  // 見出しの下に出す場所。bucket と prefix を / で繋ぐ。空 prefix は (root) と表記。
  const readmeLocation = prefix
    ? `${bucket} / ${prefix.replace(/\/$/, '')}`
    : `${bucket} / (root)`
  const title = 'README を編集'
  const description = <span className="mono">{readmeLocation}</span>

  // 導線は ReadmeView 側で隠しているが、URL を直に開かれた場合の受け皿。
  // 実際の遮断は API 側 (PUT が 403) が担う。
  if (!caps.readmeWrite) {
    return (
      <>
        <EditorPageHeader title={title} description={description} />
        <p className="state-message">この接続では README の編集が無効になっています。</p>
      </>
    )
  }
  if (state.status === 'loading') {
    return (
      <>
        <EditorPageHeader title={title} description={description} />
        <p className="state-message">読み込み中…</p>
      </>
    )
  }
  if (state.status === 'failed') {
    return (
      <>
        <EditorPageHeader title={title} description={description} />
        <LoadFailedNotice subject="README" reason={state.reason} onRetry={retry}>
          既存の本文を上書きしないよう、読み込めるまで編集できません。
        </LoadFailedNotice>
      </>
    )
  }
  const data = state.value

  const handleInsert = (entry: InsertableEntry) => {
    // 表示テキスト: ディレクトリには末尾 / を付ける。
    const display = entry.isDir ? `${entry.name}/` : entry.name
    // mado 内 URL を組み立て。fullKey は S3 のフルキー (prefix 含む)。
    const url = `/storage/${encodeURIComponent(connectionId)}/${encodeURIComponent(bucket)}/${encPath(entry.fullKey)}`
    editorRef.current?.insertAtCursor(`[${display}](${url})`)
  }

  const goBack = () => {
    const back = `/storage/${encodeURIComponent(connectionId)}/${encodeURIComponent(bucket)}/${encPath(prefix)}`
    navigate(back)
  }

  return (
    <EditorShell
      title={title}
      description={description}
      initialBody={data.exists ? data.body : ''}
      onSave={(body, editor) =>
        api.putReadme({ connectionId, bucket, prefix, body, editor }).then(() => undefined)
      }
      onSaved={goBack}
      onCancel={goBack}
      leftPane={
        <InsertableFileList
          connectionId={connectionId}
          bucket={bucket}
          prefix={prefix}
          onInsert={handleInsert}
        />
      }
    >
      {({ body, setBody }) => (
        <MonacoMarkdownEditor
          ref={editorRef}
          value={body}
          onChange={setBody}
          height="100%"
          ariaLabel="README 本文 (Markdown)"
        />
      )}
    </EditorShell>
  )
}
