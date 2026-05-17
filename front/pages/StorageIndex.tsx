import {useCallback, useEffect, useState} from 'react'
import {Link} from 'react-router-dom'
import {api} from '../lib/api/client'
import {ConnectionSwitcher} from '../components/ConnectionSwitcher'
import {ReadmeSearchPanel} from '../components/ReadmeSearchPanel'
import {S3PathPanel} from '../components/S3PathPanel'
import {CacheMeta} from '../components/CacheMeta'

interface BucketRow {
    name: string;
    creationDate: string | null
}

interface Props {
    connId: string
}

const sectionTitleClass =
    'mt-7 mb-3 text-[10.5px] font-semibold uppercase tracking-[0.22em] text-ink-7 first-of-type:mt-0'
const listClass = 'm-0 list-none p-0'
const liClass =
    'flex min-w-0 items-baseline gap-3 px-1 py-3 transition-colors hover:bg-ink-0'
const linkClass =
    'min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-semibold ' +
    'tracking-[-0.005em] text-ink-12 no-underline hover:underline underline-offset-[3px]'

export default function StorageIndex({connId}: Props) {
    const [buckets, setBuckets] = useState<BucketRow[]>([])
    // 関数形式: そうしないと毎レンダ new Set() が走って即破棄される。
    const [favorites, setFavorites] = useState<Set<string>>(() => new Set())
    const [error, setError] = useState<string | null>(null)
    const [loading, setLoading] = useState(false)

    const refresh = useCallback(() => {
        setLoading(true)
        setError(null)
        Promise.all([api.buckets(connId), api.favorites(connId)])
            .then(([bucketsRes, favs]) => {
                setBuckets(bucketsRes.buckets)
                setFavorites(new Set(favs))
            })
            .catch((e: Error) => setError(e.message))
            .finally(() => setLoading(false))
    }, [connId])

    const forceRefresh = useCallback(() => {
        api.invalidateBuckets(connId)
        api.invalidateFavorites(connId)
        refresh()
    }, [connId, refresh])

    useEffect(() => {
        refresh()
    }, [refresh])

    const toggleFavorite = async (name: string) => {
        const isFav = favorites.has(name)
        const next = new Set(favorites)
        if (isFav) next.delete(name)
        else next.add(name)
        setFavorites(next)
        try {
            if (isFav) await api.removeFavorite(connId, name)
            else await api.addFavorite(connId, name)
        } catch (e) {
            setFavorites(favorites)
            setError((e as Error).message)
        }
    }

    // 1 パス分割: filter を 2 回回すより 1 ループで dispatch する。
    // バケット数は通常少ないので実害は小さいが、規約として揃える。
    const favoriteRows: BucketRow[] = []
    const otherRows: BucketRow[] = []
    for (const b of buckets) {
        (favorites.has(b.name) ? favoriteRows : otherRows).push(b)
    }

    return (
        <section>
            <header className="page-head">
                <h2>Storage</h2>
                <CacheMeta fetchedAt={api.lastFetched.buckets(connId)} />
                <button
                    className="ghost"
                    onClick={forceRefresh}
                    disabled={loading}
                    title="キャッシュを破棄して再読み込み"
                    aria-label="再読み込み"
                >
                    <span aria-hidden>↻</span>
                </button>
                <ConnectionSwitcher/>
            </header>

            <ReadmeSearchPanel connId={connId}/>
            <S3PathPanel connId={connId}/>

            {error && <p className="error">{error}</p>}
            {loading && buckets.length === 0 && (
                <p className="text-[13px] text-ink-7">loading…</p>
            )}
            {!loading && !error && buckets.length === 0 && (
                <p className="text-[13px] text-ink-7">バケットが見つかりません。</p>
            )}

            {favoriteRows.length > 0 && (
                <>
                    <h3 className={sectionTitleClass}>現在使っているバケット</h3>
                    <ul
                        className={listClass}
                        style={{borderTop: '1px solid var(--rule)'}}
                    >
                        {favoriteRows.map(b => (
                            <BucketLi
                                key={b.name}
                                connId={connId}
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
                    <h3 className={sectionTitleClass}>その他のバケット</h3>
                    <ul
                        className={listClass}
                        style={{borderTop: '1px solid var(--rule)'}}
                    >
                        {otherRows.map(b => (
                            <BucketLi
                                key={b.name}
                                connId={connId}
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
                      connId, bucket, inUse, onToggle,
                  }: {
    connId: string; bucket: BucketRow; inUse: boolean; onToggle: () => void
}) {
    const checkboxId = `use-${bucket.name}`
    return (
        <li className={liClass} style={{borderBottom: '1px solid var(--rule)'}}>
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
            <Link
                className={linkClass}
                to={`/storage/${encodeURIComponent(connId)}/${encodeURIComponent(bucket.name)}/`}
            >
                {bucket.name}
            </Link>
            {bucket.creationDate && (
                <span
                    className="font-mono text-[11.5px] text-ink-7 shrink-0"
                    style={{letterSpacing: '0.01em'}}
                >
          {bucket.creationDate.slice(0, 10)}
        </span>
            )}
        </li>
    )
}
