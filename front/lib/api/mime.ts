export type PreviewKind = 'text' | 'image' | 'audio' | 'archive' | 'unknown'

export function classify(key: string): PreviewKind {
  const k = key.toLowerCase()
  if (k.endsWith('.tar') || k.endsWith('.tar.gz') ||
      k.endsWith('.tgz') || k.endsWith('.tar.xz')) {
    return 'archive'
  }
  const ext = /\.([a-z0-9]+)$/.exec(k)?.[1] ?? ''
  if (['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) return 'image'
  // 音声: <audio> で再生できる主要フォーマットを広く拾う。ブラウザ/OS のコーデック
  // 次第で再生できないもの (wma, aiff 等) も含むが、その場合もプレイヤー + DL ボタンが
  // 出るので「プレビュー非対応」より親切。サーバ側 Content-Type は
  // api/routes/storage-preview.ts の AUDIO_MIME と対応させること。
  if ([
    'mp3', 'wav', 'flac', 'ogg', 'oga', 'opus',
    'm4a', 'm4b', 'aac', 'weba',
    'aiff', 'aif', 'wma',
  ].includes(ext)) return 'audio'
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
