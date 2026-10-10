import {useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode} from 'react'
import {createPortal} from 'react-dom'
import {Link, useNavigate, useSearchParams} from 'react-router-dom'
import {Gauge, Tags} from 'lucide-react'
import {api} from '../lib/api/client'
import {ConnectionSwitcher} from '../components/ConnectionSwitcher'
import {ReadmeSearchPanel} from '../components/ReadmeSearchPanel'
import {S3PathPanel} from '../components/S3PathPanel'
import {CacheBanner} from '../components/storage/CacheBanner'
import {TagBadge} from '../components/TagBadge'
import {TagPicker} from '../components/TagPicker'
import {TagSearchView} from '../components/TagSearchView'
import {ViewBreadcrumb} from '../components/ViewBreadcrumb'
import {useTagsEnabled} from '../lib/useFeatureEnabled'
import {CopyMenu, type MenuItem} from '../components/CopyMenu'
import {absoluteUrl} from '../lib/route'
import type {ListBuckets, Tag} from '../lib/api/types'
import {createRevalidationReceiver} from '../lib/revalidationReceiver'

interface BucketRow {
    name: string;
    creationDate: string | null
}

interface Props {
    connectionId: string
}

const EMPTY_FAVORITES = new Set<string>()
const EMPTY_BUCKETS: BucketRow[] = []

export default function StorageIndex({connectionId}: Props) {
    const [searchParams] = useSearchParams()
    const indexHref = `/storage/${encodeURIComponent(connectionId)}/`
    const [loadedBucketList, setLoadedBucketList] = useState<ListBuckets | null>(null)
    // 関数形式: そうしないと毎レンダ new Set() が走って即破棄される。
    const [loadedFavorites, setLoadedFavorites] = useState<Set<string>>(() => new Set())
    const [loadError, setLoadError] = useState<{connectionId: string; message: string} | null>(null)
    const [loadedConnectionId, setLoadedConnectionId] = useState<string | null>(null)
    const [refreshingBuckets, setRefreshingBuckets] = useState(false)
    // 期限切れキャッシュを表示したまま裏でバケット一覧を再取得中か。
    const [revalidating, setRevalidating] = useState(false)
    // 遅い応答が接続切替をまたいで届いたときに別接続のバケットを描かないための gate。
    const sessionRef = useRef(0)
    const bucketList = loadedConnectionId === connectionId ? loadedBucketList : null
    const buckets = bucketList?.buckets ?? EMPTY_BUCKETS
    const favorites = loadedConnectionId === connectionId ? loadedFavorites : EMPTY_FAVORITES
    const error = loadError?.connectionId === connectionId ? loadError.message : null
    // 接続切替直後は effect で同期 setState せず、取得済み identity との差から
    // loading を導出する。旧接続の一覧も新しい接続へ一瞬表示されない。
    const loading = refreshingBuckets || loadedConnectionId !== connectionId

    // opts.refresh は再読み込みからのみ true。通常のロードで貫通させると
    // サーバーキャッシュの意味が無くなる。
    const refresh = useCallback((opts: { refresh?: boolean } = {}) => {
        const sid = ++sessionRef.current
        const current = (): boolean => sessionRef.current === sid
        const receiver = createRevalidationReceiver<ListBuckets>(value => {
            if (current()) setLoadedBucketList(value)
        })
        Promise.all([
            api.buckets(connectionId, {
                refresh: opts.refresh,
                // 期限切れキャッシュが返ってきたときだけ呼ばれる。
                onRevalidate: fresh => {
                    if (!current()) return
                    setRevalidating(true)
                    fresh
                        .then(r => { if (current()) { receiver.receiveRevalidated(r); setRevalidating(false) } })
                        .catch(() => { if (current()) setRevalidating(false) })
                },
            }),
            api.favorites(connectionId),
        ])
            .then(([bucketsRes, favs]) => {
                if (!current()) return
                receiver.receiveInitial(bucketsRes)
                setLoadedFavorites(new Set(favs))
                setLoadError(null)
                setLoadedConnectionId(connectionId)
            })
            .catch((e: Error) => {
                if (!current()) return
                setLoadError({connectionId, message: e.message})
                setLoadedConnectionId(connectionId)
            })
            .finally(() => { if (current()) setRefreshingBuckets(false) })
    }, [connectionId])

    const forceRefresh = useCallback(() => {
        setRefreshingBuckets(true)
        setLoadError(null)
        api.invalidateBuckets(connectionId)
        api.invalidateFavorites(connectionId)
        refresh({ refresh: true })
    }, [connectionId, refresh])

    useEffect(() => {
        refresh()
    }, [refresh])

    const tagsEnabled = useTagsEnabled()
    const [allTags, setAllTags] = useState<Tag[]>([])
    const [bucketTags, setBucketTags] = useState<Record<string, string[]>>({})

    useEffect(() => { api.tags().then(setAllTags).catch(() => {}) }, [connectionId])

    // storage_tag_assignments は (connection_id, bucket, target_kind, target_path) で
    // 一意 — kind='bucket' の対象は「bucket カラムそのもの」で path は常に '' (Task 3)。
    // つまりここで欲しいのは「複数バケットそれぞれの kind='bucket' タグ」であり、
    // api.tagAssignments({ connectionId, bucket, kind, paths }) の「1 bucket 固定 + 複数 path の
    // バッチ」という軸とは合わない。bucket 数ぶん並列 Promise.all で取得する
    // (ラボ規模の bucket 数を想定。数百件規模になったら bucket 複数対応の別モードを検討)。
    useEffect(() => {
        let cancelled = false
        Promise.all(buckets.map(b =>
            api.tagAssignments({ connectionId, bucket: b.name, kind: 'bucket', paths: [''] }).then(m => [b.name, m[''] ?? []] as const),
        )).then(entries => {
            if (!cancelled) setBucketTags(Object.fromEntries(entries))
        }).catch(() => {})
        return () => { cancelled = true }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [connectionId, buckets.map(b => b.name).join(' ')])

    const handleTagsChange = useCallback((bucketName: string, tagIds: string[]) => {
        setBucketTags(prev => ({ ...prev, [bucketName]: tagIds }))
    }, [])

    const toggleFavorite = async (name: string) => {
        const isFav = favorites.has(name)
        const next = new Set(favorites)
        if (isFav) next.delete(name)
        else next.add(name)
        setLoadedFavorites(next)
        try {
            if (isFav) await api.removeFavorite(connectionId, name)
            else await api.addFavorite(connectionId, name)
        } catch (e) {
            setLoadedFavorites(favorites)
            setLoadError({connectionId, message: (e as Error).message})
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
    // (/storage/:connectionId/tags) にすると "tags" という名前のバケットが
    // 開けなくなるため — S3 のバケット名として普通にあり得る。
    // 無効にした機能は URL を直に開かれても一覧へ倒す。
    if (searchParams.get('view') === 'tags' && tagsEnabled) {
        return (
            <section>
                {/* バケット画面と同じ見出し (パンくず / h1 / 接続先の切り替え・コピー・上へ)。 */}
                <ViewBreadcrumb connectionId={connectionId} label="タグ検索" href={`${indexHref}?view=tags`}/>
                <TagSearchView connectionId={connectionId}/>
            </section>
        )
    }

    const bucketRow = (b: BucketRow, inUse: boolean) => (
        <BucketTableRow
            key={b.name}
            connectionId={connectionId}
            bucket={b}
            inUse={inUse}
            onToggle={() => toggleFavorite(b.name)}
            allTags={allTags}
            tagIds={bucketTags[b.name] ?? []}
            onTagsChange={handleTagsChange}
            tagsEnabled={tagsEnabled}
        />
    )

    return (
        <section className="storage-index">
            <header className="page-header">
                <div>
                    <h1>Storage</h1>
                </div>
                {/* 右側の操作をひとまとめにして右寄せする。狭い画面では見出しの下へ回る。 */}
                <div className="page-actions">
                    <CacheBanner
                        fetchedAt={bucketList?.cache ? new Date(bucketList.cache.fetchedAt) : null}
                        revalidating={revalidating}
                        onRefresh={forceRefresh}
                        compact
                    />
                    <ConnectionSwitcher/>
                </div>
            </header>

            {/* 探す手段 (README 全文検索・S3 パスで移動)。広い画面では横に並べる。 */}
            <div className="storage-index-finders">
                <ReadmeSearchPanel connectionId={connectionId}/>
                <S3PathPanel connectionId={connectionId}/>
            </div>
            {/* タグ検索は別ビューへのリンクにする。畳んだパネルとして
                ここに積むと、README 検索・S3 パス貼付と合わせて一覧の前が混み合う。 */}
            <nav className="storage-index-links">
                <Link to="?view=capacity">
                    <Gauge size={14} aria-hidden="true"/>
                    バケット容量メトリクスを見る
                </Link>
                {tagsEnabled && (
                    <Link to="?view=tags">
                        <Tags size={14} aria-hidden="true"/>
                        タグ検索
                    </Link>
                )}
            </nav>

            {error && <p className="notice error">{error}</p>}
            {loading && buckets.length === 0 && (
                <p className="state-message">読み込み中…</p>
            )}
            {!loading && !error && buckets.length === 0 && (
                <p className="state-message">バケットが見つかりません。</p>
            )}

            {favoriteRows.length > 0 && (
                <BucketSection title="現在使っているバケット">
                    {favoriteRows.map(b => bucketRow(b, true))}
                </BucketSection>
            )}

            {otherRows.length > 0 && (
                <BucketSection title="その他のバケット">
                    {otherRows.map(b => bucketRow(b, false))}
                </BucketSection>
            )}
        </section>
    )
}

/** バケットの表 1 つ分 (見出し + 共通の表)。使っているもの・その他で 2 つ並ぶ。 */
function BucketSection({title, children}: { title: string; children: ReactNode }) {
    return (
        <section className="bucket-section">
            <div className="section-heading">
                <h2>{title}</h2>
            </div>
            <div className="table-scroll">
                <table className="bucket-table">
                    <thead>
                    <tr>
                        <th scope="col" className="bucket-col-use"><span className="sr-only">使用中</span></th>
                        <th scope="col">バケット</th>
                        <th scope="col" className="bucket-col-date">作成日</th>
                        <th scope="col" className="bucket-col-actions"><span className="sr-only">操作</span></th>
                    </tr>
                    </thead>
                    <tbody>{children}</tbody>
                </table>
            </div>
        </section>
    )
}

// 行の中で、それ自身の操作を持つもの (とその列)。ここを押したときは行を開かない。
// チェックボックスや操作のメニューを押し損ねたときにバケットへ入ってしまわないよう、列ごと外す。
const ROW_CONTROLS = 'a, button, input, label, .bucket-col-use, .bucket-col-actions'

function BucketTableRow({
                            connectionId, bucket, inUse, onToggle, allTags, tagIds, onTagsChange, tagsEnabled,
                        }: {
    connectionId: string; bucket: BucketRow; inUse: boolean; onToggle: () => void
    allTags: Tag[]; tagIds: string[]; onTagsChange: (bucketName: string, tagIds: string[]) => void
    tagsEnabled: boolean
}) {
    const navigate = useNavigate()
    const [pickerOpen, setPickerOpen] = useState(false)
    const checkboxId = `use-${bucket.name}`
    const tags = tagsEnabled ? allTags.filter(t => tagIds.includes(t.id)) : []
    // バケット直下を指す URL。パンくず (prefix='') と同じ形に揃えるので
    // S3 URL は末尾スラッシュ付き `s3://<bucket>/` になる。
    const bucketHref = `/storage/${encodeURIComponent(connectionId)}/${encodeURIComponent(bucket.name)}/`
    const items = useMemo<MenuItem[]>(() => [
        ...(tagsEnabled
            ? [{kind: 'action' as const, label: 'タグを編集', onSelect: () => setPickerOpen(true)}]
            : []),
        {kind: 'copy', label: 'Web URL をコピー', value: absoluteUrl(bucketHref)},
        {kind: 'copy', label: 'S3 URL をコピー', value: `s3://${bucket.name}/`},
    ], [bucketHref, bucket.name, tagsEnabled])

    // 行のどこを押してもバケットへ入れるようにする (名前の文字列だけが当たり判定だと
    // 狭くて押しづらい)。名前の列は <a> の当たり判定を列全体へ広げ (after:inset-0)、
    // 中クリックや「新しいタブで開く」が効く本物のリンクのまま保つ。ほかの列 (作成日)
    // はここで拾う。チェックボックスと操作のメニューはそれぞれの操作のまま。
    const openFromRow = (event: MouseEvent<HTMLTableRowElement>) => {
        if ((event.target as Element).closest(ROW_CONTROLS)) return
        navigate(bucketHref)
    }

    return (
        <>
            <tr className="bucket-row" onClick={openFromRow}>
                <td className="bucket-col-use">
                    <label
                        className="bucket-use"
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
                </td>
                <td className="relative">
                    <div className="bucket-name">
                        <Link className="after:absolute after:inset-0" to={bucketHref}>
                            {bucket.name}
                        </Link>
                        {tags.length > 0 && (
                            <span className="badge-group">
                                {tags.map(t => <TagBadge key={t.id} tag={t}/>)}
                            </span>
                        )}
                    </div>
                </td>
                <td className="bucket-col-date mono">{bucket.creationDate?.slice(0, 10) ?? ''}</td>
                <td className="bucket-col-actions">
                    <CopyMenu items={items}/>
                </td>
            </tr>
            {/* 表の外 (body) に出す: <tbody> の中に <div> を作らず、ダイアログの中の
                クリックで行が開かないようにする。 */}
            {pickerOpen && createPortal(
                <TagPicker
                    connectionId={connectionId} bucket={bucket.name} kind="bucket" path="" label={bucket.name}
                    allTags={allTags} assignedTagIds={tagIds}
                    onChange={next => onTagsChange(bucket.name, next)}
                    onClose={() => setPickerOpen(false)}
                />,
                document.body,
            )}
        </>
    )
}
