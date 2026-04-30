import { useParams } from 'react-router-dom'
import { Breadcrumb } from '../components/Breadcrumb'
import { S3Browser } from '../components/S3Browser'

export default function S3Bucket() {
  const params = useParams<{ bucket: string; '*': string }>()
  const bucket = decodeURIComponent(params.bucket ?? '')
  const prefix = params['*'] ?? ''
  return (
    <section>
      <Breadcrumb bucket={bucket} prefix={prefix} />
      <S3Browser bucket={bucket} prefix={prefix} />
    </section>
  )
}
