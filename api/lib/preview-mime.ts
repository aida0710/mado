export const IMAGE_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png:  'image/png',
  webp: 'image/webp',
  gif:  'image/gif',
}

// front/lib/api/mime.ts の classify() の audio 拡張子集合と対応させること。
// ここに無い拡張子は audio として classify されても application/octet-stream で
// 返るため、ブラウザが再生を拒むことがある。
export const AUDIO_MIME: Record<string, string> = {
  mp3:  'audio/mpeg',
  wav:  'audio/wav',
  flac: 'audio/flac',
  ogg:  'audio/ogg',
  oga:  'audio/ogg',
  opus: 'audio/ogg',
  m4a:  'audio/mp4',
  m4b:  'audio/mp4',
  aac:  'audio/aac',
  weba: 'audio/webm',
  aiff: 'audio/aiff',
  aif:  'audio/aiff',
  wma:  'audio/x-ms-wma',
}

// front/lib/api/mime.ts の video 拡張子集合と対応させること。
// 動画はブラウザが途中から読み込めるよう、audio と同じく Range を透過する。
export const VIDEO_MIME: Record<string, string> = {
  mp4: 'video/mp4',
}

export function ext(key: string): string {
  const extensionMatch = /\.([a-z0-9]+)$/i.exec(key)
  return extensionMatch ? extensionMatch[1].toLowerCase() : ''
}

const TEXT_EXT = new Set([
  'txt', 'md',
  'jsonl', 'ndjson',
  'yaml', 'yml',
  'csv', 'tsv', 'log',
])

// tar エントリ名の MIME タイプ (/storage/:connectionId/preview/tar-entry で使用)。
export function entryContentType(name: string): string {
  const extension = ext(name)
  if (IMAGE_MIME[extension]) return IMAGE_MIME[extension]
  if (AUDIO_MIME[extension]) return AUDIO_MIME[extension]
  if (VIDEO_MIME[extension]) return VIDEO_MIME[extension]
  if (extension === 'json') return 'application/json; charset=utf-8'
  if (TEXT_EXT.has(extension)) return 'text/plain; charset=utf-8'
  return 'application/octet-stream'
}
