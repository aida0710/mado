import type { Tag } from '../../lib/api/types'
import { TagBadge } from '../TagBadge'

// タグは名前の「右」ではなく「下」に別行で出す。右に並べると、長いキーほど
// 名前側の truncate / break-all が効いてファイル名・ディレクトリ名が読めなく
// なるため。呼び出し側は glyph の隣の列 (名前と同じ列) に置いて字下げを揃える。
function TagRow({ tags }: { tags: Tag[] }) {
  if (tags.length === 0) return null
  return (
    <span className="mt-1 flex flex-wrap gap-1">
      {tags.map(t => <TagBadge key={t.id} tag={t} />)}
    </span>
  )
}

interface Props {
  kind: 'directory' | 'file'
  /** 現ディレクトリ基準で末尾だけにした名前。 */
  tail: string
  tags: Tag[]
  /** table は 1 行に収める (truncate)、card は折り返して全部見せる (break-all)。 */
  overflow: 'truncate' | 'break-all'
}

/** 一覧の 1 エントリの名前部分。glyph + 名前 + タグ行。
 *  文字色や太さは directory / file で違い、リンクの有無は呼び出し側が決める。 */
export function EntryLabel({ kind, tail, tags, overflow }: Props) {
  return (
    <>
      {kind === 'directory'
        // dir glyph: chevron — folder シンボルとしての editorial 表現
        ? <span aria-hidden className="text-ink-5 select-none text-[10px]">▸</span>
        // file glyph: 控えめな点 — タイポ的に存在を主張しすぎない
        : <span aria-hidden className="text-ink-3 select-none text-[10px]">·</span>}
      <span className="min-w-0 flex-1">
        {kind === 'directory'
          ? <span className={`block ${overflow}`}>{tail}</span>
          : (
            <span
              className={`block ${overflow} text-ink-11`}
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '12.5px',
                letterSpacing: '0.005em',
              }}
            >
              {tail}
            </span>
          )}
        <TagRow tags={tags} />
      </span>
    </>
  )
}
