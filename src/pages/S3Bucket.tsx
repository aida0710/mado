import { useParams } from 'react-router-dom'

export default function S3Bucket() {
  const params = useParams<{ bucket: string; '*': string }>()
  const bucket = decodeURIComponent(params.bucket ?? '')
  const prefix = params['*'] ?? ''
  return (
    <section>
      <header className="page-head">
        <h2>{bucket}</h2>
      </header>
      <p className="muted">prefix: {prefix || '(root)'} — 準備中</p>
    </section>
  )
}
