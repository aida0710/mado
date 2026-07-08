import { useCallback } from 'react'
import { Navigate, useParams, useSearchParams } from 'react-router-dom'
import { Breadcrumb } from '../components/Breadcrumb'
import { ConnectionSwitcher } from '../components/ConnectionSwitcher'
import { StorageBrowser } from '../components/StorageBrowser'
import { ReadmeView } from '../components/ReadmeView'
import { PreviewDrawer } from '../components/PreviewDrawer'
import { fileLinkToDirRedirect } from '../lib/route'
import { useDrawerResize } from '../lib/useDrawerResize'

interface Props { connId: string }

export default function StorageBucket({ connId }: Props) {
  const params = useParams<{ bucket: string; '*': string }>()
  const bucket = decodeURIComponent(params.bucket ?? '')
  const prefix = params['*'] ?? ''

  // 選択中ファイルは URL の ?preview=<key> で表現する。
  // 直リンク (deep-link) で復元可能、選択するたびに URL も更新するので
  // ブラウザの戻る/進むも自然に効く。
  const [searchParams, setSearchParams] = useSearchParams()
  const selected = searchParams.get('preview')

  const setSelected = useCallback((key: string | null) => {
    setSearchParams(
      prev => {
        const next = new URLSearchParams(prev)
        if (key === null) next.delete('preview')
        else next.set('preview', key)
        return next
      },
      { replace: false },
    )
  }, [setSearchParams])

  // preview drawer の幅をリサイズ可能にする (≥1024px のみ実効。CSS 側で gate)。
  const { containerRef, onResizeStart, onResizeKeyDown, resetWidth, widthCustomized } =
    useDrawerResize(selected != null)

  // ファイル直リンク (末尾が `/` でない URL) なら、親ディレクトリのリスト +
  // `?preview=<key>` にリダイレクトする。README に貼った Markdown リンクや
  // 別アプリで生成された URL から「ファイルそのものに飛んできた」ケースで、
  // 親の並びを開きつつ preview drawer をそのファイルに合わせて開いた状態に揃える。
  // ディレクトリ判定は trailing slash 単純判定 — S3 慣習に沿うので確実。
  // (フックは全て上で無条件に呼んでから分岐する — rules-of-hooks 遵守。)
  if (prefix !== '' && !prefix.endsWith('/')) {
    return <Navigate to={fileLinkToDirRedirect(connId, bucket, prefix)} replace />
  }

  return (
    <section className="storage-bucket">
      <div className="flex items-center justify-between gap-3">
        <Breadcrumb connId={connId} bucket={bucket} prefix={prefix} />
        <ConnectionSwitcher />
      </div>
      {/* README はリスト幅に依存させない (常に full width) */}
      <ReadmeView connId={connId} bucket={bucket} prefix={prefix} />
      {/* リスト + preview drawer を横並び。drawer 幅は drawer 左端のハンドルで
          リサイズでき、広げるとリストを圧縮せず上に重なる (useDrawerResize)。
          ハンドルは drawer 内に置き、その高さに収める。README には影響しない。 */}
      <div className="storage-list" ref={containerRef}>
        <StorageBrowser connId={connId} bucket={bucket} prefix={prefix} onSelectFile={setSelected} />
        <PreviewDrawer
          connId={connId}
          bucket={bucket}
          k={selected}
          onClose={() => setSelected(null)}
          onResizeStart={onResizeStart}
          onResizeKeyDown={onResizeKeyDown}
          onResetWidth={resetWidth}
          widthCustomized={widthCustomized}
        />
      </div>
    </section>
  )
}
