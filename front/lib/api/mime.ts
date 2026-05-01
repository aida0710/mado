export type PreviewKind = 'text' | 'image' | 'audio' | 'archive' | 'unknown'

export function classify(key: string): PreviewKind {
  const k = key.toLowerCase()
  if (k.endsWith('.tar') || k.endsWith('.tar.gz') ||
      k.endsWith('.tgz') || k.endsWith('.tar.xz')) {
    return 'archive'
  }
  const ext = /\.([a-z0-9]+)$/.exec(k)?.[1] ?? ''
  if (['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) return 'image'
  if (['mp3', 'wav', 'flac', 'ogg'].includes(ext)) return 'audio'
  if ([
    'txt', 'md',
    'json', 'jsonl', 'ndjson',
    'yaml', 'yml',
    'csv', 'tsv', 'log',
  ].includes(ext)) {
    return 'text'
  }
  return 'unknown'
}

// tar 内エントリ用のサブセット — tar-in-tar はレンダリングしない。
export type EntryKind = Exclude<PreviewKind, 'archive'>

export function classifyEntry(name: string): EntryKind {
  const k = classify(name)
  return k === 'archive' ? 'unknown' : k
}
