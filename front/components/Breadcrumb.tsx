import { Link } from 'react-router-dom'
import { useConnection } from '../lib/connectionContext'

// "Up one level" from the current bucket+prefix:
//   /storage/<conn>/b/voice/jp/  → /storage/<conn>/b/voice/
//   /storage/<conn>/b/voice/     → /storage/<conn>/b/
//   /storage/<conn>/b/           → /storage/<conn>/        (bucket index)
function parentPath(connId: string, bucket: string, prefix: string): string {
  const segs = prefix.split('/').filter(Boolean)
  if (segs.length === 0) return `/storage/${connId}/`
  const trimmed = segs.slice(0, -1)
  const parentPrefix = trimmed.length === 0 ? '' : trimmed.join('/') + '/'
  return `/storage/${connId}/${encodeURIComponent(bucket)}/${parentPrefix}`
}

export function Breadcrumb({
  connId, bucket, prefix,
}: { connId: string; bucket: string; prefix: string }) {
  const connection = useConnection()
  const segments = prefix.split('/').filter(Boolean)
  return (
    <nav className="breadcrumb">
      <Link
        className="breadcrumb__back"
        to={parentPath(connId, bucket, prefix)}
        aria-label="親階層へ"
        title="親階層へ"
      >
        ←
      </Link>
      <Link to={`/storage/${connId}/`}>{connection.name}</Link>
      <span className="breadcrumb__sep">/</span>
      <Link to={`/storage/${connId}/${encodeURIComponent(bucket)}/`}>{bucket}</Link>
      {segments.map((seg, i) => {
        const subPrefix = segments.slice(0, i + 1).join('/') + '/'
        return (
          <span key={subPrefix}>
            <span className="breadcrumb__sep">/</span>
            <Link to={`/storage/${connId}/${encodeURIComponent(bucket)}/${subPrefix}`}>
              {seg}
            </Link>
          </span>
        )
      })}
      {prefix && <span className="breadcrumb__sep">/</span>}
    </nav>
  )
}
