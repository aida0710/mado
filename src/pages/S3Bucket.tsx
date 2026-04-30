import { useParams } from 'react-router-dom'
import { Breadcrumb } from '../components/Breadcrumb'
import { S3Browser } from '../components/S3Browser'
import { ReadmeView } from '../components/ReadmeView'

export default function S3Bucket() {
  const params = useParams<{ bucket: string; '*': string }>()
  const bucket = decodeURIComponent(params.bucket ?? '')
  const prefix = params['*'] ?? ''
  return (
    <section>
      <Breadcrumb bucket={bucket} prefix={prefix} />
      <S3Browser bucket={bucket} prefix={prefix} />
      <ReadmeView bucket={bucket} prefix={prefix} />
    </section>
  )
}
