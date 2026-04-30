import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'

interface BucketRow { name: string; creationDate: string | null }

export default function S3Index() {
  const [buckets, setBuckets] = useState<BucketRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setLoading(true)
    setError(null)
    api.buckets()
      .then(r => setBuckets(r.buckets))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  return (
    <section>
      <header className="page-head">
        <h2>mdx S3 / バケット</h2>
      </header>
      {error && <p className="error">{error}</p>}
      {loading && buckets.length === 0 && <p className="muted">loading…</p>}
      {!loading && !error && buckets.length === 0 && (
        <p className="muted">バケットが見つかりません。</p>
      )}
      <ul className="bucket-list">
        {buckets.map(b => (
          <li key={b.name}>
            <Link to={`/s3/${encodeURIComponent(b.name)}/`}>{b.name}</Link>
            {b.creationDate && (
              <span className="muted"> · {b.creationDate.slice(0, 10)}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
