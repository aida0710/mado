import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { Breadcrumb } from '../components/Breadcrumb'
import { ConnectionSwitcher } from '../components/ConnectionSwitcher'
import { StorageBrowser } from '../components/StorageBrowser'
import { ReadmeView } from '../components/ReadmeView'
import { PreviewDrawer } from '../components/PreviewDrawer'

interface Props { connId: string }

export default function StorageBucket({ connId }: Props) {
  const params = useParams<{ bucket: string; '*': string }>()
  const bucket = decodeURIComponent(params.bucket ?? '')
  const prefix = params['*'] ?? ''
  const [selected, setSelected] = useState<string | null>(null)
  return (
    <section className="storage-bucket">
      <div className="storage-main">
        <div className="flex items-center justify-between gap-3">
          <Breadcrumb connId={connId} bucket={bucket} prefix={prefix} />
          <ConnectionSwitcher />
        </div>
        <ReadmeView connId={connId} bucket={bucket} prefix={prefix} />
        <StorageBrowser connId={connId} bucket={bucket} prefix={prefix} onSelectFile={setSelected} />
      </div>
      <PreviewDrawer
        connId={connId}
        bucket={bucket}
        k={selected}
        onClose={() => setSelected(null)}
      />
    </section>
  )
}
