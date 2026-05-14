// `/storage/:connId/edit-readme/:bucket/*` — 任意 prefix の README を Monaco で編集する
// 2-pane ページ。左ペインに「現在 prefix の直下のファイル/ディレクトリ」を出し、
// 行クリックで Monaco の現在カーソル位置に `[name](/storage/conn/bucket/path)` を挿入する。
//
// 保存後は元の StorageBucket ページに戻る。

import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { z } from 'zod'
import { api } from '../lib/api/client'
import { encPath } from '../lib/route'
import type { Readme } from '../lib/api/types'
import { EditorShell } from '../components/EditorShell'
import { InsertableFileList, type InsertableEntry } from '../components/InsertableFileList'
import {
  MonacoMarkdownEditor,
  type MonacoMarkdownEditorHandle,
} from '../components/MonacoMarkdownEditor'

type ReadmeData = z.infer<typeof Readme>

interface Props { connId: string }

export default function ReadmeEditPage({ connId }: Props) {
  // React Router v7 では splat は params['*'] で取れる。
  const params = useParams<{ bucket: string; '*': string }>()
  const bucket = params.bucket ?? ''
  // URL splat (例: 'docs/sub') を S3 prefix 形式 ('docs/sub/' or '') に正規化。
  const splat = params['*'] ?? ''
  const prefix = splat === '' ? '' : splat.endsWith('/') ? splat : splat + '/'

  const navigate = useNavigate()
  const [data, setData] = useState<ReadmeData | null>(null)
  const editorRef = useRef<MonacoMarkdownEditorHandle>(null)

  useEffect(() => {
    if (!bucket) return
    let cancelled = false
    api.readme(connId, bucket, prefix)
      .then(r => { if (!cancelled) setData(r) })
      .catch(() => { if (!cancelled) setData({ exists: false }) })
    return () => { cancelled = true }
  }, [connId, bucket, prefix])

  if (!bucket) {
    return <p className="text-[13px] text-ink-7">bucket がありません</p>
  }
  if (!data) {
    return <p className="text-[13px] text-ink-7">読み込み中…</p>
  }

  const handleInsert = (entry: InsertableEntry) => {
    // 表示テキスト: ディレクトリには末尾 / を付ける。
    const display = entry.isDir ? `${entry.name}/` : entry.name
    // mado 内 URL を組み立て。fullKey は S3 のフルキー (prefix 含む)。
    const url = `/storage/${encodeURIComponent(connId)}/${encodeURIComponent(bucket)}/${encPath(entry.fullKey)}`
    editorRef.current?.insertAtCursor(`[${display}](${url})`)
  }

  const goBack = () => {
    const back = `/storage/${encodeURIComponent(connId)}/${encodeURIComponent(bucket)}/${encPath(prefix)}`
    navigate(back)
  }

  // kicker は bucket と prefix を / で繋いだもの。空 prefix は (root) と表記。
  const kickerLocation = prefix
    ? `${bucket} / ${prefix.replace(/\/$/, '')}`
    : `${bucket} / (root)`

  return (
    <EditorShell
      kicker={`README — ${kickerLocation}`}
      title="README を編集"
      initialBody={data.exists ? data.body : ''}
      initialEditor={data.exists && data.last_editor ? data.last_editor : ''}
      onSave={(body, editor) =>
        api.putReadme(connId, bucket, prefix, body, editor).then(() => undefined)
      }
      onSaved={goBack}
      onCancel={goBack}
      leftPane={
        <InsertableFileList
          connId={connId}
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
