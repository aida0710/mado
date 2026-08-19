import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {Link, useSearchParams} from 'react-router-dom'
import {api} from '../lib/api/client'
import {ConnectionSwitcher} from '../components/ConnectionSwitcher'
import {ReadmeSearchPanel} from '../components/ReadmeSearchPanel'
import {S3PathPanel} from '../components/S3PathPanel'
import {CacheMeta} from '../components/CacheMeta'
import {TagBadge} from '../components/TagBadge'
import {TagPicker} from '../components/TagPicker'
import {TagSearchView} from '../components/TagSearchView'
import {ViewBreadcrumb} from '../components/ViewBreadcrumb'
import {useTagsEnabled} from '../lib/useFeatureEnabled'
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
const subLinkClass =
    'text-[12px] text-ink-9 no-underline hover:text-ink-12 hover:underline underline-offset-[3px]'

export default function StorageIndex({connId}: Props) {
    const [searchParams] = useSearchParams()
    const indexHref = `/storage/${encodeURIComponent(connId)}/`
    const [buckets, setBuckets] = useState<BucketRow[]>([])
    // 関数形式: そうしないと毎レンダ new Set() が走って即破棄される。
    const [favorites, setFavorites] = useState<Set<string>>(() => new Set())
    const [error, setError] = useState<string | null>(null)
    const [loading, setLoading] = useState(false)
    // 期限切れキャッシュを表示したまま裏でバケット一覧を再取得中か。
    const [revalidating, setRevalidating] = useState(false)
    // 遅い応答が接続切替をまたいで届いたときに別接続のバケットを描かないための gate。
    const sessionRef = useRef(0)

    // opts.refresh は ↻ からのみ true。通常のロードで貫通させると
    // サーバーキャッシュの意味が無くなる。
    const refresh = useCallback((opts: { refresh?: boolean } = {}) => {
        setLoading(true)
        setError(null)
        const sid = ++sessionRef.current
        const current = (): boolean => sessionRef.current === sid
        Promise.all([
            api.buckets(connId, {
                refresh: opts.refresh,
                // 期限切れキャッシュが返ってきたときだけ呼ばれる。
                onRevalidate: fresh => {
                    if (!current()) return
                    setRevalidating(true)
                    fresh
                        .then(r => { if (current()) { setBuckets(r.buckets); setRevalidating(false) } })
                        .catch(() => { if (current()) setRevalidating(false) })
                },
            }),
            api.favorites(connId),
        ])
            .then(([bucketsRes, favs]) => {
                if (!current()) return
                setBuckets(bucketsRes.buckets)
                setFavorites(new Set(favs))
            })
            .catch((e: Error) => { if (current()) setError(e.message) })
            .finally(() => { if (current()) setLoading(false) })
    }, [connId])

    const forceRefresh = useCallback(() => {
        api.invalidateBuckets(connId)
        api.invalidateFavorites(connId)
        refresh({ refresh: true })
    }, [connId, refresh])

    useEffect(() => {
        refresh()
    }, [refresh])

    const tagsEnabled = useTagsEnabled()
    const [allTags, setAllTags] = useState<Tag[]>([])
    const [bucketTags, setBucketTags] = useState<Record<string, string[]>>({})

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

    // タグ検索は ?view=tags で表現する。固定セグメント
    // (/storage/:connId/tags) にすると "tags" という名前のバケットが
    // 開けなくなるため — S3 のバケット名として普通にあり得る。
    // 無効にした機能は URL を直に開かれても一覧へ倒す。
    if (searchParams.get('view') === 'tags' && tagsEnabled) {
        return (
            <section>
                {/* バケット画面 (Breadcrumb + ConnectionSwitcher) と同じ並びに揃える。 */}
                <div className="flex items-center justify-between gap-3">
                    <ViewBreadcrumb connId={connId} label="タグ検索" href={`${indexHref}?view=tags`}/>
                    <ConnectionSwitcher/>
                </div>
                <TagSearchView connId={connId}/>
            </section>
        )
    }

    return (
        <section>
            <header className="page-head">
                <h2>Storage</h2>
                {/* 右側の操作をひとまとめにして右寄せする。個別に並べると、
                    狭い画面で CONN だけ次の行へ折り返ったとき行頭 (左) に落ち、
                    そこから開くドロップダウンが画面外へはみ出す。 */}
                <div className="ml-auto flex flex-wrap items-center justify-end gap-3">
                    <CacheMeta fetchedAt={api.lastFetched.buckets(connId)} revalidating={revalidating} />
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
                </div>
            </header>

            <ReadmeSearchPanel connId={connId}/>
            <S3PathPanel connId={connId}/>
            {/* タグ検索は別ビューへのリンクにする。畳んだパネルとして
                ここに積むと、README 検索・S3 パス貼付と合わせて一覧の前が混み合う。 */}
            {tagsEnabled && (
                <nav className="mt-3 mb-4 flex flex-wrap items-center gap-x-4 gap-y-1">
                    <Link className={subLinkClass} to="?view=tags">タグ検索</Link>
                </nav>
            )}

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
                                allTags={allTags}
                                tagIds={bucketTags[b.name] ?? []}
                                onTagsChange={handleTagsChange}
                                tagsEnabled={tagsEnabled}
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
                                allTags={allTags}
                                tagIds={bucketTags[b.name] ?? []}
                                onTagsChange={handleTagsChange}
                                tagsEnabled={tagsEnabled}
                            />
                        ))}
                    </ul>
                </>
            )}
        </section>
    )
}

function BucketLi({
                      connId, bucket, inUse, onToggle, allTags, tagIds, onTagsChange, tagsEnabled,
                  }: {
    connId: string; bucket: BucketRow; inUse: boolean; onToggle: () => void
    allTags: Tag[]; tagIds: string[]; onTagsChange: (bucketName: string, tagIds: string[]) => void
    tagsEnabled: boolean
}) {
    const [pickerOpen, setPickerOpen] = useState(false)
    const checkboxId = `use-${bucket.name}`
    const tags = tagsEnabled ? allTags.filter(t => tagIds.includes(t.id)) : []
    // バケット直下を指す URL。パンくず (prefix='') と同じ形に揃えるので
    // S3 URL は末尾スラッシュ付き `s3://<bucket>/` になる。
    const bucketHref = `/storage/${encodeURIComponent(connId)}/${encodeURIComponent(bucket.name)}/`
    const items = useMemo<MenuItem[]>(() => [
        ...(tagsEnabled
            ? [{kind: 'action' as const, label: 'タグを編集', onSelect: () => setPickerOpen(true)}]
            : []),
        {kind: 'copy', label: 'Web URL をコピー', value: absoluteUrl(bucketHref)},
        {kind: 'copy', label: 'S3 URL をコピー', value: `s3://${bucket.name}/`},
    ], [bucketHref, bucket.name, tagsEnabled])
    return (
        <li className={`${liClass} relative`} style={{borderBottom: '1px solid var(--rule)'}}>
            {/* チェックボックスと ⋯ は行リンクの上に出す (下の after:inset-0 が
                行全体を覆うので、z を上げないとクリックを奪われる)。 */}
            <label
                className="use-toggle relative z-[1]"
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
                {/* 行のどこを押してもバケットへ入れるようにする (名前の文字列だけが
                    当たり判定だと狭くて押しづらい)。onClick ハンドラではなく
                    after:inset-0 で <a> の当たり判定を行全体へ広げる方式にして、
                    中クリックや「新しいタブで開く」が効く本物のリンクのまま保つ。 */}
                <Link className={`${linkClass} after:absolute after:inset-0`} to={bucketHref}>
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
            <span className="relative z-[1] shrink-0">
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
