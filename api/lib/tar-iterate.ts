// tar (無圧縮 / gz / xz) を 1 パスで読み、通常ファイルエントリごとに本体を
// Buffer にして `onEntry` へ渡す逐次イテレータ。データセットスキャン用:
// S3 から tar を 1 回流すだけで中の全音声を解析できるようにする
// (エントリごとの解析は Buffer 相手なので追加の S3 アクセスは発生しない)。
//
// 解凍パイプの組み立て (`createDecompressor`) とイベントベースの
// `extract().on('entry', (header, stream, next) => ...)` 走査スタイルは
// 既存の tar-stream.ts (`extractTarEntry` / `listTarEntries`) に合わせている。
import { pipeline } from 'node:stream'
import { extract as tarExtract } from 'tar-stream'
import { createDecompressor, type ArchiveKind } from './tar-stream.js'

export interface TarEntryHeader {
  name: string
  size: number
}

export async function iterateTarEntries(
  stream: NodeJS.ReadableStream,
  kind: ArchiveKind,
  onEntry: (header: TarEntryHeader, body: Buffer) => Promise<void>,
  opts: { entryMaxBytes: number },
): Promise<void> {
  await new Promise<void>((resolveP, rejectP) => {
    const ext = tarExtract()
    let settled = false

    const finish = (err?: Error | null) => {
      if (settled) return
      settled = true
      if (err) rejectP(err)
      else resolveP()
    }

    ext.on('entry', (header, entryStream, next) => {
      const isFile = header.type === 'file'
      const size = header.size ?? 0
      if (!isFile || size > opts.entryMaxBytes) {
        // 対象外 (ディレクトリ等) または上限超過 — 本体を読み捨てて次へ。
        entryStream.on('end', next)
        entryStream.resume()
        return
      }
      const chunks: Buffer[] = []
      entryStream.on('data', (chunk: Buffer) => chunks.push(chunk))
      entryStream.on('end', () => {
        onEntry({ name: header.name, size }, Buffer.concat(chunks))
          .then(() => next())
          .catch((err: Error) => {
            // extract ストリームを破棄すると pipeline() のコールバックが
            // このエラーで一度だけ呼ばれ、finish() に到達する。
            ext.destroy(err)
          })
      })
      entryStream.resume()
    })

    pipeline(stream, createDecompressor(kind), ext, err => finish(err))
  })
}
