import { Link } from 'react-router-dom'

// "Up one level" from the current bucket+prefix:
//   /s3/b/voice/jp/  → /s3/b/voice/
//   /s3/b/voice/     → /s3/b/
//   /s3/b/           → /s3/        (bucket index)
function parentPath(bucket: string, prefix: string): string {
  const segs = prefix.split('/').filter(Boolean)
  if (segs.length === 0) return '/s3/'
  const trimmed = segs.slice(0, -1)
  const parentPrefix = trimmed.length === 0 ? '' : trimmed.join('/') + '/'
  return `/s3/${encodeURIComponent(bucket)}/${parentPrefix}`
}

export function Breadcrumb({ bucket, prefix }: { bucket: string; prefix: string }) {
  const segments = prefix.split('/').filter(Boolean)
  return (
    <nav className="breadcrumb">
      <Link
        className="breadcrumb__back"
        to={parentPath(bucket, prefix)}
        aria-label="親階層へ"
        title="親階層へ"
      >
        ←
      </Link>
      <Link to={`/s3/${encodeURIComponent(bucket)}/`}>{bucket}</Link>
      {segments.map((seg, i) => {
        const subPrefix = segments.slice(0, i + 1).join('/') + '/'
        return (
          <span key={subPrefix}>
            <span className="breadcrumb__sep">/</span>
            <Link to={`/s3/${encodeURIComponent(bucket)}/${subPrefix}`}>
              {seg}
            </Link>
          </span>
        )
      })}
      {prefix && <span className="breadcrumb__sep">/</span>}
    </nav>
  )
}
