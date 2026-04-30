import { Link, useNavigate } from 'react-router-dom'

export function Breadcrumb({ bucket, prefix }: { bucket: string; prefix: string }) {
  const navigate = useNavigate()
  const segments = prefix.split('/').filter(Boolean)
  return (
    <nav className="breadcrumb">
      <button
        type="button"
        className="breadcrumb__back"
        onClick={() => navigate(-1)}
        aria-label="戻る"
        title="戻る"
      >
        ←
      </button>
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
