import { useEffect, useReducer, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api/client'
import type { Tag, TagSearchResult } from '../lib/api/types'
import { encPath, fileLinkToDirRedirect, parseS3Path } from '../lib/route'
import { TagBadge } from './TagBadge'
import { ImportExportButtons } from './ImportExportButtons'
import { downloadJson, type ImportMode, type ImportSummary } from '../lib/jsonFile'

// 「どの場所にどのタグが付いているか」の入出力形式。
//
// タグは id ではなく name で参照する。id は環境ごとの nanoid で、またいで
// 意味を持たないため。対象は `s3://bucket/key` の 1 本のフルパスで書く
// (家系図のエクスポートと同じ表記)。バケット直下は `s3://bucket/`、
// ディレクトリは末尾スラッシュ付き、ファイルは無し — kind はパスから決まる
// ので別フィールドにしない。
//
// tags には使われているタグの定義 (name + color) を同梱する。取り込み先に
// 無いタグを作り直せるようにするため。
interface TagAssignmentsExport {
  mado: 'tag-assignments'
  version: 1
  tags: Array<{ name: string; color: string }>
  assignments: Array<{ tag: string; target: string }>
}

function targetUri(hit: Hit): string {
  return `s3://${hit.bucket}/${hit.path}`
}

// パスから対象種別を決める (nodeKind と同じ規約。TargetKind 名に合わせて
// directory ではなく prefix を返す)。
function kindOf(path: string): 'bucket' | 'prefix' | 'file' {
  if (path === '') return 'bucket'
  return path.endsWith('/') ? 'prefix' : 'file'
}

interface Props {
  connId: string
}

type Hit = TagSearchResult[number]

function hrefFor(connId: string, hit: Hit): string {
  if (hit.kind === 'bucket') {
    return `/storage/${encodeURIComponent(connId)}/${encodeURIComponent(hit.bucket)}/`
  }
  if (hit.kind === 'prefix') {
    return `/storage/${encodeURIComponent(connId)}/${encodeURIComponent(hit.bucket)}/${encPath(hit.path)}`
  }
  return fileLinkToDirRedirect(connId, hit.bucket, hit.path)
}

// hits/loading/error は useReducer で持つ。useState のセッターを useEffect 内で
// 直接呼ぶと react-hooks/set-state-in-effect (eslint) に引っかかるが、
// useReducer の dispatch はこのルールの対象外 (ReadmeSearchPanel と同じ既存パターン)。
interface SearchState {
  hits: TagSearchResult | null
  loading: boolean
  error: string | null
}

type SearchAction =
  | { type: 'idle' }
  | { type: 'start' }
  | { type: 'ok'; hits: TagSearchResult }
  | { type: 'err'; error: string }

const initialSearch: SearchState = { hits: null, loading: false, error: null }

function searchReducer(s: SearchState, a: SearchAction): SearchState {
  switch (a.type) {
    case 'idle':
      return initialSearch
    case 'start':
      return { ...s, loading: true, error: null }
    case 'ok':
      return { ...s, hits: a.hits, loading: false }
    case 'err':
      return { ...s, error: a.error, loading: false }
  }
}

const KIND_LABEL: Record<Hit['kind'], string> = {
  bucket: 'バケット', prefix: 'ディレクトリ', file: 'ファイル',
}

// タグ検索。Storage (バケット一覧) からリンクで開く独立したビュー。
//
// もとはバケット一覧の上に畳んだパネルとして置いていたが、README 検索 /
// S3 パス貼付と並んで一覧の前に積み上がり、ページが混み合っていた。
// 選んだタグのいずれかが付いた bucket/ディレクトリ/ファイルを列挙する (OR)。
export function TagSearchView({ connId }: Props) {
  const [allTags, setAllTags] = useState<Tag[]>([])
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [search, dispatch] = useReducer(searchReducer, initialSearch)
  const { hits, loading, error } = search

  useEffect(() => {
    api.tags().then(setAllTags).catch(() => {})
  }, [connId])

  useEffect(() => {
    if (selected.size === 0) {
      dispatch({ type: 'idle' })
      return
    }
    let cancelled = false
    dispatch({ type: 'start' })
    api.tagSearch(connId, [...selected])
      .then(r => { if (!cancelled) dispatch({ type: 'ok', hits: r }) })
      .catch((e: Error) => { if (!cancelled) dispatch({ type: 'err', error: e.message }) })
    return () => { cancelled = true }
  }, [connId, selected])

  // 取り込み先に無いタグが出たときの確認。onImport の途中で聞きたいので、
  // ダイアログの応答を Promise で受け取る形にする。
  const [pendingMissing, setPendingMissing] =
    useState<{ names: string[]; resolve: (create: boolean) => void } | null>(null)
  const askCreateMissing = (names: string[]) =>
    new Promise<boolean>(resolve => setPendingMissing({ names, resolve }))
  const answerMissing = (create: boolean) => {
    pendingMissing?.resolve(create)
    setPendingMissing(null)
  }

  const handleExport = async () => {
    // tagSearch に全タグ ID を渡すと接続内の全割り当てが返る。
    const hits = allTags.length === 0 ? [] : await api.tagSearch(connId, allTags.map(t => t.id))
    const byId = new Map(allTags.map(t => [t.id, t]))
    const usedIds = new Set(hits.map(h => h.tagId))
    const body: TagAssignmentsExport = {
      mado: 'tag-assignments',
      version: 1,
      tags: allTags.filter(t => usedIds.has(t.id)).map(t => ({ name: t.name, color: t.color })),
      assignments: hits.map(h => ({ tag: byId.get(h.tagId)?.name ?? h.tagId, target: targetUri(h) })),
    }
    downloadJson('mado-tag-assignments.json', body)
  }

  const handleImport = async (data: unknown, mode: ImportMode): Promise<ImportSummary> => {
    const d = data as Partial<TagAssignmentsExport> | null
    if (d?.mado !== 'tag-assignments' || d.version !== 1 || !Array.isArray(d.assignments)) {
      throw new Error('mado のタグ割り当てのエクスポートファイルではありません。')
    }

    // 名前 → タグ。取り込み先に無い名前は、作ってよいか聞いてから作る。
    let byName = new Map(allTags.map(t => [t.name, t]))
    const wanted = [...new Set(d.assignments.map(a => a?.tag).filter((n): n is string => typeof n === 'string'))]
    const missing = wanted.filter(n => !byName.has(n))
    const summary: ImportSummary = { added: 0, skipped: 0, removed: 0, failed: [] }

    if (missing.length > 0) {
      const create = await askCreateMissing(missing)
      if (!create) {
        // 作らない場合、そのタグの割り当ては入れられないので失敗として数える。
        summary.failed.push(`未登録のタグ: ${missing.join(', ')}`)
      } else {
        const colorOf = new Map((d.tags ?? []).map(t => [t.name, t.color]))
        for (const name of missing) {
          try {
            const created = await api.createTag({ name, color: colorOf.get(name) ?? '#8e887b' })
            byName = new Map(byName).set(name, created)
          } catch (e) {
            summary.failed.push(`${name}: ${(e as Error).message}`)
          }
        }
      }
    }

    // 既存の割り当てはスキップする。PUT 自体は冪等 (ON CONFLICT DO NOTHING)
    // だが、「何件が新規だったか」を出したいのでこちら側でも見る。
    const known = [...byName.values()]
    const current = known.length === 0 ? [] : await api.tagSearch(connId, known.map(t => t.id))
    const existing = new Set(current.map(h => `${h.tagId}|${targetUri(h)}`))

    // 置き換え = 同期。ファイルに無い割り当てを外す。消えるのは
    // storage_tag_assignments の行だけで、タグ定義そのものは残る。
    if (mode === 'replace') {
      const wanted = new Set(
        d.assignments
          .map(a => {
            const tag = typeof a?.tag === 'string' ? byName.get(a.tag) : undefined
            const parsed = typeof a?.target === 'string' ? parseS3Path(a.target) : null
            return tag && parsed ? `${tag.id}|s3://${parsed.bucket}/${parsed.prefix}` : null
          })
          .filter((k): k is string => k !== null),
      )
      for (const h of current) {
        const k = `${h.tagId}|${targetUri(h)}`
        if (wanted.has(k)) continue
        try {
          await api.unassignTag(connId, h.bucket, h.kind, h.path, h.tagId)
          summary.removed = (summary.removed ?? 0) + 1
          existing.delete(k)
        } catch (e) {
          summary.failed.push(`${targetUri(h)}: ${(e as Error).message}`)
        }
      }
    }

    for (const a of d.assignments) {
      const tag = typeof a?.tag === 'string' ? byName.get(a.tag) : undefined
      const parsed = typeof a?.target === 'string' ? parseS3Path(a.target) : null
      if (!parsed) {
        summary.failed.push(`対象として読めない項目があります: ${String(a?.target)}`)
        continue
      }
      if (!tag) { summary.skipped++; continue }
      if (existing.has(`${tag.id}|s3://${parsed.bucket}/${parsed.prefix}`)) { summary.skipped++; continue }
      try {
        await api.assignTag(connId, parsed.bucket, kindOf(parsed.prefix), parsed.prefix, tag.id)
        summary.added++
      } catch (e) {
        summary.failed.push(`${a.target}: ${(e as Error).message}`)
      }
    }
    return summary
  }

  const toggle = (tagId: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(tagId)) next.delete(tagId); else next.add(tagId)
      return next
    })
  }

  return (
    <section>
      <div className="mt-1 flex flex-wrap items-center justify-end">
        <ImportExportButtons
          what="タグ割り当て"
          onExport={() => { void handleExport() }}
          onImport={handleImport}
          onDone={() => setSelected(new Set(selected))}
        />
      </div>

      {pendingMissing && (
        <div className="modal-backdrop" role="presentation">
          <button
            type="button"
            className="modal-backdrop__close-overlay"
            onClick={() => answerMissing(false)}
            aria-label="モーダルを閉じる"
            tabIndex={-1}
          />
          <div className="modal modal--narrow" role="dialog" aria-modal="true" aria-labelledby="tag-missing-title">
            <h3 id="tag-missing-title" className="lineage-add__title">未登録のタグがあります</h3>
            <p className="lineage-add__target">{pendingMissing.names.join(' / ')}</p>
            <p className="text-[12px] text-ink-7">
              作成すると、これらのタグを登録したうえで割り当てを取り込みます。
              作成しない場合、このタグの割り当ては取り込まれません。
            </p>
            <div className="modal-actions">
              <button type="button" onClick={() => answerMissing(false)}>作成しない</button>
              <button type="button" onClick={() => answerMissing(true)}>作成して取り込む</button>
            </div>
          </div>
        </div>
      )}

      {allTags.length === 0 ? (
        <p className="mt-4 text-[13px] text-ink-7">
          タグがまだありません。<Link to="/settings">Settings</Link> で作成してください。
        </p>
      ) : (
        <>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {allTags.map(tag => (
              <button
                key={tag.id}
                type="button"
                onClick={() => toggle(tag.id)}
                className="cursor-pointer border-0 bg-transparent p-0"
                // 未選択は淡くするが 0.4 だと薄い。バッジ自体が淡いティントに
                // なったので、それより薄くすると読めなくなる。
                style={{ opacity: selected.size === 0 || selected.has(tag.id) ? 1 : 0.55 }}
                aria-pressed={selected.has(tag.id)}
              >
                <TagBadge tag={tag} />
              </button>
            ))}
            {selected.size > 0 && (
              <button type="button" className="ghost" onClick={() => setSelected(new Set())}>
                クリア
              </button>
            )}
            {loading && <span className="text-[11px] text-ink-7">検索中…</span>}
          </div>

          {error && <p className="error mt-3">{error}</p>}

          {selected.size === 0 && !error && (
            <p className="mt-4 text-[13px] text-ink-7">タグを選ぶと、付いている場所を一覧します。</p>
          )}

          {hits !== null && hits.length === 0 && !loading && !error && (
            <p className="mt-4 text-[13px] text-ink-7">この接続にヒットなし。</p>
          )}

          {hits !== null && hits.length > 0 && (
            <>
              <p className="mt-5 text-[10.5px] font-semibold uppercase tracking-[0.22em] text-ink-7">
                {hits.length} 件
              </p>
              <ul className="m-0 mt-2 list-none p-0" style={{ borderTop: '1px solid var(--rule)' }}>
                {hits.map(h => (
                  <li
                    key={`${h.tagId}|${h.bucket}|${h.kind}|${h.path}`}
                    className="px-1 py-2.5 transition-colors hover:bg-ink-0"
                    style={{ borderBottom: '1px solid var(--rule)' }}
                  >
                    <Link to={hrefFor(connId, h)} className="block text-ink-12 no-underline">
                      <span className="wrap-anywhere">
                        <span
                          className="text-[12.5px] text-ink-7"
                          style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.005em' }}
                        >
                          {h.bucket}<span>/</span>
                        </span>
                        <span
                          className="text-[12.5px] font-medium text-ink-12"
                          style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.005em' }}
                        >
                          {h.kind === 'bucket' ? '(bucket root)' : h.path}
                        </span>
                      </span>
                      <span className="mt-0.5 block text-[11px] text-ink-7">
                        {KIND_LABEL[h.kind]}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  )
}
