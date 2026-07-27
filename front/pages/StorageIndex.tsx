import {useCallback, useEffect, useMemo, useState} from 'react'
import {Link} from 'react-router-dom'
import {api} from '../lib/api/client'
import {ConnectionSwitcher} from '../components/ConnectionSwitcher'
import {ReadmeSearchPanel} from '../components/ReadmeSearchPanel'
import {S3PathPanel} from '../components/S3PathPanel'
import {CacheMeta} from '../components/CacheMeta'
import {TagBadge} from '../components/TagBadge'
import {TagPicker} from '../components/TagPicker'
import {TagSearchPanel} from '../components/TagSearchPanel'
import {TagFilterBar} from '../components/storage/TagFilterBar'
import {CopyMenu, type MenuItem} from '../components/CopyMenu'
import {absoluteUrl} from '../lib/route'
import type {Tag} from '../lib/api/types'

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
// block: 親が flex コンテナでなくなった (タグ行と縦積みするラッパ div の中) ので、
// 明示しないと inline のままで text-ellipsis が効かない。
const linkClass =
    'block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-semibold ' +
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

    const [allTags, setAllTags] = useState<Tag[]>([])
    const [bucketTags, setBucketTags] = useState<Record<string, string[]>>({})
    const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(() => new Set())

    useEffect(() => { api.tags().then(setAllTags).catch(() => {}) }, [connId])

    // storage_tag_assignments は (connection_id, bucket, target_kind, target_path) で
    // 一意 — kind='bucket' の対象は「bucket カラムそのもの」で path は常に '' (Task 3)。
    // つまりここで欲しいのは「複数バケットそれぞれの kind='bucket' タグ」であり、
    // api.tagAssignments(connId, bucket, kind, paths) の「1 bucket 固定 + 複数 path の
    // バッチ」という軸とは合わない。bucket 数ぶん並列 Promise.all で取得する
    // (ラボ規模の bucket 数を想定。数百件規模になったら bucket 複数対応の別モードを検討)。
    useEffect(() => {
        let cancelled = false
        Promise.all(buckets.map(b =>
            api.tagAssignments(connId, b.name, 'bucket', ['']).then(m => [b.name, m[''] ?? []] as const),
        )).then(entries => {
            if (!cancelled) setBucketTags(Object.fromEntries(entries))
        }).catch(() => {})
        return () => { cancelled = true }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [connId, buckets.map(b => b.name).join(' ')])

    const handleTagsChange = useCallback((bucketName: string, tagIds: string[]) => {
        setBucketTags(prev => ({ ...prev, [bucketName]: tagIds }))
    }, [])

    const visibleTagIds = useMemo(() => new Set(Object.values(bucketTags).flat()), [bucketTags])
    const filterCandidates = useMemo(
        () => allTags.filter(t => visibleTagIds.has(t.id)),
        [allTags, visibleTagIds],
    )
    const toggleTagFilter = useCallback((tagId: string) => {
        setSelectedTagIds(prev => {
            const next = new Set(prev)
            if (next.has(tagId)) next.delete(tagId); else next.add(tagId)
            return next
        })
    }, [])
    const matchesSelectedTags = useCallback((bucketName: string): boolean => {
        if (selectedTagIds.size === 0) return true
        const ids = bucketTags[bucketName] ?? []
        return ids.some(id => selectedTagIds.has(id))
    }, [selectedTagIds, bucketTags])

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

    const visibleFavoriteRows = favoriteRows.filter(b => matchesSelectedTags(b.name))
    const visibleOtherRows = otherRows.filter(b => matchesSelectedTags(b.name))

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
            <TagSearchPanel connId={connId}/>
            <TagFilterBar
                tags={filterCandidates}
                selected={selectedTagIds}
                onToggle={toggleTagFilter}
                onClear={() => setSelectedTagIds(new Set())}
            />
            <S3PathPanel connId={connId}/>

            {error && <p className="error">{error}</p>}
            {loading && buckets.length === 0 && (
                <p className="text-[13px] text-ink-7">loading…</p>
            )}
            {!loading && !error && buckets.length === 0 && (
                <p className="text-[13px] text-ink-7">バケットが見つかりません。</p>
            )}

            {visibleFavoriteRows.length > 0 && (
                <>
                    <h3 className={sectionTitleClass}>現在使っているバケット</h3>
                    <ul
                        className={listClass}
                        style={{borderTop: '1px solid var(--rule)'}}
                    >
                        {visibleFavoriteRows.map(b => (
                            <BucketLi
                                key={b.name}
                                connId={connId}
                                bucket={b}
                                inUse
                                onToggle={() => toggleFavorite(b.name)}
                                allTags={allTags}
                                tagIds={bucketTags[b.name] ?? []}
                                onTagsChange={handleTagsChange}
                            />
                        ))}
                    </ul>
                </>
            )}

            {visibleOtherRows.length > 0 && (
                <>
                    <h3 className={sectionTitleClass}>その他のバケット</h3>
                    <ul
                        className={listClass}
                        style={{borderTop: '1px solid var(--rule)'}}
                    >
                        {visibleOtherRows.map(b => (
                            <BucketLi
                                key={b.name}
                                connId={connId}
                                bucket={b}
                                inUse={false}
                                onToggle={() => toggleFavorite(b.name)}
                                allTags={allTags}
                                tagIds={bucketTags[b.name] ?? []}
                                onTagsChange={handleTagsChange}
                            />
                        ))}
                    </ul>
                </>
            )}
        </section>
    )
}

function BucketLi({
                      connId, bucket, inUse, onToggle, allTags, tagIds, onTagsChange,
                  }: {
    connId: string; bucket: BucketRow; inUse: boolean; onToggle: () => void
    allTags: Tag[]; tagIds: string[]; onTagsChange: (bucketName: string, tagIds: string[]) => void
}) {
    const [pickerOpen, setPickerOpen] = useState(false)
    const checkboxId = `use-${bucket.name}`
    const tags = allTags.filter(t => tagIds.includes(t.id))
    // バケット直下を指す URL。パンくず (prefix='') と同じ形に揃えるので
    // S3 URL は末尾スラッシュ付き `s3://<bucket>/` になる。
    const bucketHref = `/storage/${encodeURIComponent(connId)}/${encodeURIComponent(bucket.name)}/`
    const items = useMemo<MenuItem[]>(() => [
        {kind: 'action', label: 'タグを編集', onSelect: () => setPickerOpen(true)},
        {kind: 'copy', label: 'Web URL をコピー', value: absoluteUrl(bucketHref)},
        {kind: 'copy', label: 'S3 URL をコピー', value: `s3://${bucket.name}/`},
    ], [bucketHref, bucket.name])
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
            {/* タグは名前の右ではなく下の行に置く (EntryTable と同じ理由 —
                右に並べると長いバケット名が truncate されて読めなくなる)。 */}
            <div className="min-w-0 flex-1">
                <Link className={linkClass} to={bucketHref}>
                    {bucket.name}
                </Link>
                {tags.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                        {tags.map(t => <TagBadge key={t.id} tag={t} />)}
                    </div>
                )}
            </div>
            {bucket.creationDate && (
                <span
                    className="font-mono text-[11.5px] text-ink-7 shrink-0"
                    style={{letterSpacing: '0.01em'}}
                >
          {bucket.creationDate.slice(0, 10)}
        </span>
            )}
            <span className="shrink-0">
                <CopyMenu items={items}/>
            </span>
            {pickerOpen && (
                <TagPicker
                    connId={connId} bucket={bucket.name} kind="bucket" path="" label={bucket.name}
                    allTags={allTags} assignedTagIds={tagIds}
                    onChange={next => onTagsChange(bucket.name, next)}
                    onClose={() => setPickerOpen(false)}
                />
            )}
        </li>
    )
}
