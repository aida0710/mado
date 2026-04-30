import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'

interface BucketRow { name: string; creationDate: string | null }

export default function S3Index() {
  const [buckets, setBuckets] = useState<BucketRow[]>([])
  const [favorites, setFavorites] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(() => {
    setLoading(true)
    setError(null)
    Promise.all([api.buckets(), api.favorites()])
      .then(([bucketsRes, favs]) => {
        setBuckets(bucketsRes.buckets)
        setFavorites(new Set(favs))
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const toggleFavorite = async (name: string) => {
    const isFav = favorites.has(name)
    // Optimistic update
    const next = new Set(favorites)
    if (isFav) next.delete(name)
    else next.add(name)
    setFavorites(next)
    try {
      if (isFav) await api.removeFavorite(name)
      else await api.addFavorite(name)
    } catch (e) {
      // Roll back on failure.
      setFavorites(favorites)
      setError((e as Error).message)
    }
  }

  const favoriteRows = buckets.filter(b => favorites.has(b.name))
  const otherRows    = buckets.filter(b => !favorites.has(b.name))

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

      {favoriteRows.length > 0 && (
        <>
          <h3 className="bucket-section">現在使っているバケット</h3>
          <ul className="bucket-list">
            {favoriteRows.map(b => (
              <BucketLi
                key={b.name}
                bucket={b}
                inUse
                onToggle={() => toggleFavorite(b.name)}
              />
            ))}
          </ul>
        </>
      )}

      {otherRows.length > 0 && (
        <>
          <h3 className="bucket-section">その他のバケット</h3>
          <ul className="bucket-list">
            {otherRows.map(b => (
              <BucketLi
                key={b.name}
                bucket={b}
                inUse={false}
                onToggle={() => toggleFavorite(b.name)}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

function BucketLi({
  bucket, inUse, onToggle,
}: {
  bucket: BucketRow; inUse: boolean; onToggle: () => void
}) {
  const checkboxId = `use-${bucket.name}`
  return (
    <li>
      <label
        className="use-toggle"
        htmlFor={checkboxId}
        title={inUse ? '使用中から外す' : '現在使っているバケットに追加'}
      >
        <input
          id={checkboxId}
          type="checkbox"
          checked={inUse}
          onChange={onToggle}
          aria-label={`${bucket.name} を現在使っているバケットに${inUse ? '外す' : '追加'}`}
        />
      </label>
      <Link to={`/s3/${encodeURIComponent(bucket.name)}/`}>{bucket.name}</Link>
      {bucket.creationDate && (
        <span className="muted"> · {bucket.creationDate.slice(0, 10)}</span>
      )}
    </li>
  )
}
