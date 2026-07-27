import { useCallback } from 'react'
import { Navigate, useParams, useSearchParams } from 'react-router-dom'
import { Breadcrumb } from '../components/Breadcrumb'
import { ConnectionSwitcher } from '../components/ConnectionSwitcher'
import { StorageBrowser } from '../components/StorageBrowser'
import { ReadmeView } from '../components/ReadmeView'
import { PreviewDrawer } from '../components/PreviewDrawer'
import { LineageView } from '../components/storage/lineage/LineageView'
import { fileLinkToDirRedirect } from '../lib/route'
import { useDrawerResize } from '../lib/useDrawerResize'
import { useLineageEnabled } from '../lib/useLineageEnabled'

interface Props { connId: string }

export default function StorageBucket({ connId }: Props) {
  const params = useParams<{ bucket: string; '*': string }>()
  const bucket = decodeURIComponent(params.bucket ?? '')
  const prefix = params['*'] ?? ''

  // 選択中ファイルは URL の ?preview=<key> で表現する。tar アーカイブを開いている
  // ときは、その中のどのエントリを開いているかを &entry=<エントリ名> で足す。
  // 直リンク (deep-link) で復元可能、選択するたびに URL も更新するので
  // ブラウザの戻る/進むも自然に効く。
  const [searchParams, setSearchParams] = useSearchParams()
  // URLSearchParams.get は値なしキー (?preview= / ?entry=) に null ではなく '' を返す。
  // 空文字列は「無し」として扱う — そのまま流すと、名前が空のエントリでモーダルが
  // 開き、?entry= への無駄なリクエストまで走る (URL の貼り付け損ねで実際に起きる)。
  const selected = searchParams.get('preview') || null
  const selectedEntry = searchParams.get('entry') || null

  const setSelected = useCallback((key: string | null) => {
    setSearchParams(
      prev => {
        const next = new URLSearchParams(prev)
        if (key === null) next.delete('preview')
        else next.set('preview', key)
        // entry は「今開いている tar の中のエントリ」を指す。preview を差し替える /
        // 閉じるときは必ず捨てる — 残すと無関係なファイルに ?entry= がぶら下がり、
        // 次にその tar を開いた瞬間に身に覚えのないモーダルが開く。
        next.delete('entry')
        return next
      },
      { replace: false },
    )
  }, [setSearchParams])

  // entry だけを出し入れする (preview は保持)。tar の中でエントリを開閉するのに使い、
  // push なので「開く = 履歴 1 段」「戻る = モーダルが閉じる」が自然に成立する。
  const setSelectedEntry = useCallback((entryPath: string | null) => {
    setSearchParams(
      prev => {
        const next = new URLSearchParams(prev)
        if (entryPath === null) next.delete('entry')
        else next.set('entry', entryPath)
        return next
      },
      { replace: false },
    )
  }, [setSearchParams])

  // preview drawer の幅をリサイズ可能にする (≥1024px のみ実効。CSS 側で gate)。
  const { containerRef, onResizeStart, onResizeKeyDown, resetWidth, widthCustomized } =
    useDrawerResize(selected != null)

  // 「一覧」/「家系図」タブは ?view=lineage で表現する。preview/entry と同様
  // URL に持たせることで直リンク・戻る/進むが自然に効く。
  //
  // 家系図が Settings で無効なら、?view=lineage で直リンクされても一覧に倒す
  // (タブが無いのに家系図が出ている、という迷子状態を作らない)。
  const lineageEnabled = useLineageEnabled()
  const view = lineageEnabled && searchParams.get('view') === 'lineage' ? 'lineage' : 'list'
  const setView = useCallback((v: 'lineage' | 'list') => {
    setSearchParams(
      prev => {
        const next = new URLSearchParams(prev)
        if (v === 'list') next.delete('view')
        else next.set('view', v)
        return next
      },
      { replace: false },
    )
  }, [setSearchParams])

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
      <nav className="storage-bucket__tabs" role="tablist" aria-label="表示切り替え">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'list'}
          className="storage-bucket__tab"
          onClick={() => setView('list')}
        >
          一覧
        </button>
        {lineageEnabled && (
          <button
            type="button"
            role="tab"
            aria-selected={view === 'lineage'}
            className="storage-bucket__tab"
            onClick={() => setView('lineage')}
          >
            🔗 家系図
          </button>
        )}
      </nav>
      {view === 'lineage' ? (
        <LineageView connId={connId} bucket={bucket} prefix={prefix} />
      ) : (
        <>
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
              entry={selectedEntry}
              onEntryChange={setSelectedEntry}
              onClose={() => setSelected(null)}
              onResizeStart={onResizeStart}
              onResizeKeyDown={onResizeKeyDown}
              onResetWidth={resetWidth}
              widthCustomized={widthCustomized}
            />
          </div>
        </>
      )}
    </section>
  )
}
