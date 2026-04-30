import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { Breadcrumb } from '../components/Breadcrumb'
import { S3Browser } from '../components/S3Browser'
import { ReadmeView } from '../components/ReadmeView'
import { PreviewDrawer } from '../components/PreviewDrawer'

export default function S3Bucket() {
  const params = useParams<{ bucket: string; '*': string }>()
  const bucket = decodeURIComponent(params.bucket ?? '')
  const prefix = params['*'] ?? ''
  const [selected, setSelected] = useState<string | null>(null)
  return (
    <section className="s3-bucket">
      <div className="s3-main">
        <Breadcrumb bucket={bucket} prefix={prefix} />
        <ReadmeView bucket={bucket} prefix={prefix} />
        <S3Browser bucket={bucket} prefix={prefix} onSelectFile={setSelected} />
      </div>
      <PreviewDrawer
        bucket={bucket}
        k={selected}
        onClose={() => setSelected(null)}
      />
    </section>
  )
}
