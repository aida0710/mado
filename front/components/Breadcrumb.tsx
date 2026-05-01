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

const linkClass =
  'text-ink-11 no-underline px-1 py-[2px] rounded-1 hover:bg-ink-1'
const sepClass = 'text-ink-3 px-[2px]'

export function Breadcrumb({
  connId, bucket, prefix,
}: { connId: string; bucket: string; prefix: string }) {
  const connection = useConnection()
  const segments = prefix.split('/').filter(Boolean)
  return (
    <nav className="flex flex-wrap items-center gap-1 my-2 text-sm">
      <Link
        className="inline-flex h-7 w-7 items-center justify-center rounded-2 border border-ink-3 bg-paper text-ink-9 no-underline hover:bg-ink-1 hover:border-ink-5 transition-colors"
        to={parentPath(connId, bucket, prefix)}
        aria-label="親階層へ"
        title="親階層へ"
      >
        ←
      </Link>
      <Link className={linkClass} to={`/storage/${connId}/`}>
        {connection.name}
      </Link>
      <span className={sepClass}>/</span>
      <Link
        className={linkClass}
        to={`/storage/${connId}/${encodeURIComponent(bucket)}/`}
      >
        {bucket}
      </Link>
      {segments.map((seg, i) => {
        const subPrefix = segments.slice(0, i + 1).join('/') + '/'
        return (
          <span key={subPrefix} className="contents">
            <span className={sepClass}>/</span>
            <Link
              className={linkClass}
              to={`/storage/${connId}/${encodeURIComponent(bucket)}/${subPrefix}`}
            >
              {seg}
            </Link>
          </span>
        )
      })}
      {prefix && <span className={sepClass}>/</span>}
    </nav>
  )
}
