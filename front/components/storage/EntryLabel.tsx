import { Link } from 'react-router-dom'
import { File, FileArchive, FileAudio, FileImage, FileVideo, Folder, type LucideIcon } from 'lucide-react'
import { classify, type PreviewKind } from '../../lib/api/mime'
import type { Tag } from '../../lib/api/types'
import { TagBadge } from '../TagBadge'

// ファイルの種類ごとのアイコン。拡張子から分かる種類だけを見分け、ほかは File にする。
const FILE_ICONS: Record<PreviewKind, LucideIcon> = {
  image: FileImage,
  audio: FileAudio,
  video: FileVideo,
  archive: FileArchive,
  unknown: File,
}

interface Props {
  kind: 'directory' | 'file'
  /** 現ディレクトリ基準で末尾だけにした名前。 */
  tail: string
  tags: Tag[]
  /** ディレクトリはリンク (中クリックや新しいタブで開けるよう本物の <a>)。 */
  href?: string
  /** ファイルの種類のアイコンを決めるためのキー。 */
  fileKey?: string
}

/** 一覧の 1 エントリの名前の列: アイコン + 名前、その横にタグ。
 *  名前が長くて入りきらないときは、タグを次の行へ回す (名前が先に潰れないように)。 */
export function EntryLabel({ kind, tail, tags, href, fileKey }: Props) {
  const Icon = kind === 'directory' ? Folder : FILE_ICONS[classify(fileKey ?? tail)]
  const name = (
    <>
      <Icon size={15} aria-hidden="true" />
      <span className="entry-name-text" title={tail}>{tail}</span>
    </>
  )
  return (
    <div className="entry-name">
      {href
        ? <Link to={href} className="entry-name-main">{name}</Link>
        : <span className="entry-name-main">{name}</span>}
      {tags.length > 0 && (
        <span className="badge-group">
          {tags.map(t => <TagBadge key={t.id} tag={t} />)}
        </span>
      )}
    </div>
  )
}
