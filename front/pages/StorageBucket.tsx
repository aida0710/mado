import { useCallback } from 'react'
import { Navigate, useParams, useSearchParams } from 'react-router-dom'
import { Breadcrumb } from '../components/Breadcrumb'
import { ConnectionSwitcher } from '../components/ConnectionSwitcher'
import { StorageBrowser } from '../components/StorageBrowser'
import { ReadmeView } from '../components/ReadmeView'
import { PreviewDrawer } from '../components/PreviewDrawer'
import { fileLinkToDirRedirect } from '../lib/route'

interface Props { connId: string }

export default function StorageBucket({ connId }: Props) {
  const params = useParams<{ bucket: string; '*': string }>()
  const bucket = decodeURIComponent(params.bucket ?? '')
  const prefix = params['*'] ?? ''

  // ファイル直リンク (末尾が `/` でない URL) なら、親ディレクトリのリスト +
  // `?preview=<key>` にリダイレクトする。README に貼った Markdown リンクや
  // 別アプリで生成された URL から「ファイルそのものに飛んできた」ケースで、
  // 親の並びを開きつつ preview drawer をそのファイルに合わせて開いた状態に揃える。
  // ディレクトリ判定は trailing slash 単純判定 — S3 慣習に沿うので確実。
  if (prefix !== '' && !prefix.endsWith('/')) {
    return <Navigate to={fileLinkToDirRedirect(connId, bucket, prefix)} replace />
  }

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

  return (
    <section className="storage-bucket">
      <div className="flex items-center justify-between gap-3">
        <Breadcrumb connId={connId} bucket={bucket} prefix={prefix} />
        <ConnectionSwitcher />
      </div>
      {/* README はリスト幅に依存させない (常に full width) */}
      <ReadmeView connId={connId} bucket={bucket} prefix={prefix} />
      {/* リスト + preview drawer を横並び。preview を開くとリストだけが
          狭くなり、README には影響しない。 */}
      <div className="storage-list">
        <StorageBrowser connId={connId} bucket={bucket} prefix={prefix} onSelectFile={setSelected} />
        <PreviewDrawer
          connId={connId}
          bucket={bucket}
          k={selected}
          onClose={() => setSelected(null)}
        />
      </div>
    </section>
  )
}
