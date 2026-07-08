import { describe, expect, it } from 'vitest'
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pack as tarPack } from 'tar-stream'
import { extractTarEntry, isMacOsMetadata, listTarEntries } from './tar-stream.js'

const here = dirname(fileURLToPath(import.meta.url))
const fix = (name: string) => resolve(here, 'test-fixtures', name)

const big = 1_000_000

// listTarEntries/extractTarEntry の cancel-crash 再現テスト用ヘルパー。
// tar-stream の pack() はエントリの「ヘッダ (512B)」と「本体」を別々の push()
// として書き出す (pack.js の Sink#_write / Pack#_encode 参照) ため、最初の
// chunk は必ず単独の 512 バイトヘッダになる。これを利用して、本体を一切
// 流さないまま 'entry' イベントだけを発火させ、確実に「エントリ処理中
// (Extract#_stream がセットされ、まだ 1 バイトも本体を受け取っていない)」
// 状態を作り出せる。
async function packHeaderOnlyChunk(name: string, bodySize: number): Promise<Buffer> {
  const p = tarPack()
  const chunks: Buffer[] = []
  const done = new Promise<void>((res, rej) => {
    p.on('data', (c: Buffer) => chunks.push(c))
    p.on('end', res)
    p.on('error', rej)
  })
  p.entry({ name, size: bodySize }, Buffer.alloc(bodySize, 7))
  p.finalize()
  await done
  return chunks[0]
}

describe('listTarEntries', () => {
  it('lists entries in plain tar', async () => {
    const r = await listTarEntries(
      createReadStream(fix('sample.tar')),
      'tar',
      { entryLimit: 10, byteLimit: big },
    )
    expect(r.truncated).toBe(false)
    expect(r.hasMore).toBe(false)
    expect(r.entries.map(e => e.name)).toEqual(expect.arrayContaining([
      'd/a.txt', 'd/b.txt', 'd/c.txt',
    ]))
  })

  it('lists entries in tar.gz', async () => {
    const r = await listTarEntries(
      createReadStream(fix('sample.tar.gz')),
      'gz',
      { entryLimit: 10, byteLimit: big },
    )
    expect(r.truncated).toBe(false)
    expect(r.hasMore).toBe(false)
    expect(r.entries.map(e => e.name).sort())
      .toEqual(['d/', 'd/a.txt', 'd/b.txt', 'd/c.txt'])
  })

  it('lists entries in tar.xz', async () => {
    const r = await listTarEntries(
      createReadStream(fix('sample.tar.xz')),
      'xz',
      { entryLimit: 10, byteLimit: big },
    )
    expect(r.truncated).toBe(false)
    expect(r.hasMore).toBe(false)
    expect(r.entries.map(e => e.name).sort())
      .toEqual(['d/', 'd/a.txt', 'd/b.txt', 'd/c.txt'])
  })

  it('stops at entryLimit and signals hasMore', async () => {
    const r = await listTarEntries(
      createReadStream(fix('sample.tar')),
      'tar',
      { entryLimit: 2, byteLimit: big },
    )
    expect(r.entries).toHaveLength(2)
    expect(r.hasMore).toBe(true)
    // entryLimit に達しても "truncated" ではない — ページネーションで回復できる。
    expect(r.truncated).toBe(false)
  })

  it('paginates with offset', async () => {
    // sample.tar.gz には 4 エントリある: d/, d/a.txt, d/b.txt, d/c.txt
    const page1 = await listTarEntries(
      createReadStream(fix('sample.tar.gz')),
      'gz',
      { entryLimit: 2, byteLimit: big, offset: 0 },
    )
    expect(page1.entries).toHaveLength(2)
    expect(page1.hasMore).toBe(true)

    const page2 = await listTarEntries(
      createReadStream(fix('sample.tar.gz')),
      'gz',
      { entryLimit: 2, byteLimit: big, offset: 2 },
    )
    expect(page2.entries).toHaveLength(2)
    expect(page2.hasMore).toBe(false)

    const allNames = [...page1.entries, ...page2.entries].map(e => e.name).sort()
    expect(allNames).toEqual(['d/', 'd/a.txt', 'd/b.txt', 'd/c.txt'])
  })

  it('offset past the end returns empty without hasMore', async () => {
    const r = await listTarEntries(
      createReadStream(fix('sample.tar.gz')),
      'gz',
      { entryLimit: 100, byteLimit: big, offset: 100 },
    )
    expect(r.entries).toEqual([])
    expect(r.hasMore).toBe(false)
  })

  it('stops at byteLimit and marks truncated', async () => {
    // 展開後の sample.tar.xz は 50 バイトを超える。バイトカウンタは
    // デコンプレッサの後に位置するため、展開後のストリームで強制される。
    const r = await listTarEntries(
      createReadStream(fix('sample.tar.xz')),
      'xz',
      { entryLimit: 10, byteLimit: 50 },
    )
    expect(r.truncated).toBe(true)
    expect(r.entries.length).toBeLessThan(4)
  })

  it('reports size on entries', async () => {
    const r = await listTarEntries(
      createReadStream(fix('sample.tar')),
      'tar',
      { entryLimit: 10, byteLimit: big },
    )
    const a = r.entries.find(e => e.name === 'd/a.txt')
    expect(a?.size).toBe(6) // 'alpha\n' の長さ
  })

  // 本番クラッシュの再現 (regression): storage-preview.ts の /preview/tar
  // stream モード (tar.gz/.tar.xz) は client 切断時に上流の S3 オブジェクト
  // ストリーム (= このテストの `source`) を destroy() する。エントリの
  // 本体を読み切る前にその destroy が起きると、node:stream の pipeline()
  // が ERR_STREAM_PREMATURE_CLOSE を作って下流の tar-stream Extract を
  // destroy し、Extract は「現在読み出し中のエントリの内部 Source ストリーム」
  // (tar-stream/extract.js の Source クラス。streamx 実装で、pipeline() が
  // 把握する source/decompressor/counter/ext のリストには含まれない別の
  // EventEmitter) を同じエラー付きで destroy する。このエントリ Source に
  // 'error' リスナーが無いと Node は未捕捉例外としてプロセスごと落とす
  // (Node の「'error' イベントにリスナーが無ければ throw する」という
  // EventEmitter の既定動作)。
  //
  // 決定的に再現するため、tar-stream の pack() が「ヘッダ (512B) を本体とは
  // 別の push() で書く」実装を利用し、本体を一切流さないまま 'entry' を
  // 発火させてから destroy する — これで「エントリ処理中」を確実に踏める
  // (fixture ファイルのようにストリーム全体が一瞬でバッファされてしまうと
  // destroy 時点で既に読み切っており、この競合は再現しない)。
  it('エントリ本体を読み切る前に upstream が destroy されても未捕捉 error でプロセスが落ちない', async () => {
    const header = await packHeaderOnlyChunk('big.bin', 64 * 1024)
    const source = new Readable({ read() {} })

    const uncaught: Error[] = []
    const onUncaught = (e: Error): void => { uncaught.push(e) }
    process.on('uncaughtException', onUncaught)
    try {
      const seenEntry = new Promise<void>(resolveEntry => {
        listTarEntries(
          source,
          'tar',
          { entryLimit: 10, byteLimit: big },
          () => resolveEntry(),
        )
          // listTarEntries 自身は pipeline() 経由で ERR_STREAM_PREMATURE_CLOSE を
          // 正しく reject として受け取る (これは呼び出し元 (route) が
          // try/catch で処理する契約通りの経路であり、このテストの主眼である
          // 「EventEmitter 'error' の未捕捉クラッシュ」とは別物)。
          .catch(() => {})
      })

      source.push(header)
      // tar-stream がヘッダを解析して 'entry' を発火し、listTarEntries が
      // stream.resume() を呼んだ直後 = 本体はまだ 1 バイトも届いていない
      // 「mid-entry」状態。
      await seenEntry

      // クライアント切断 (cancel()) を模した upstream の破棄。
      source.destroy()

      // 'error' イベント発火 (非同期; pipeline() のクリーンアップ経由) の猶予。
      await new Promise(r => setTimeout(r, 50))

      expect(uncaught).toEqual([])
    } finally {
      process.off('uncaughtException', onUncaught)
    }
  })
})

describe('extractTarEntry', () => {
  it('マッチしないエントリをドレイン中に upstream が destroy されても未捕捉 error でプロセスが落ちない', async () => {
    // /preview/tar-entry は現状クライアント abort を upstream の destroy に
    // 配線していない (c.req.raw.signal 未使用)ため本番では未到達だが、
    // extractTarEntry も listTarEntries と同じ tar-stream Extract を使う
    // 以上、同じ危険 (エントリ Source に 'error' リスナー無し) を抱える。
    // 将来 abort 配線が入っても安全なように、tar-stream.ts 側のガードで
    // 塞いでおく必要がある — その回帰テスト。
    const header = await packHeaderOnlyChunk('needle.bin', 64 * 1024)
    const source = new Readable({ read() {} })

    const uncaught: Error[] = []
    const onUncaught = (e: Error): void => { uncaught.push(e) }
    process.on('uncaughtException', onUncaught)
    try {
      // 'needle.bin' とは別名で検索させ、"マッチしないエントリをドレインする"
      // 分岐 (found=false, stream.resume() のみ) を通す。
      extractTarEntry(source, 'tar', 'does-not-exist.bin', big).catch(() => {})

      source.push(header)
      // ドレイン分岐は 'entry' ハンドラの中で同期的に stream.resume() を
      // 呼ぶだけなので、次の tick まで待てば「エントリ処理中」に入る。
      await new Promise(r => setTimeout(r, 10))

      source.destroy()
      await new Promise(r => setTimeout(r, 50))

      expect(uncaught).toEqual([])
    } finally {
      process.off('uncaughtException', onUncaught)
    }
  })
})

describe('isMacOsMetadata', () => {
  it.each<[string, boolean, string]>([
    // AppleDouble (Mac BSD tar / Finder の圧縮) — 隠す
    ['._foo.wav',         true,  'AppleDouble at root'],
    ['./._foo.wav',       true,  'AppleDouble after ./'],
    ['dir/._foo.json',    true,  'AppleDouble in subdir'],
    ['._',                true,  'bare AppleDouble prefix'],
    // .DS_Store — 隠す
    ['.DS_Store',         true,  'Finder metadata at root'],
    ['some/dir/.DS_Store', true, 'Finder metadata nested'],
    // __MACOSX/ ディレクトリ (zip でよくあるが tar でも稀に同梱される) — 隠す
    ['__MACOSX',          true,  '__MACOSX dir entry'],
    ['__MACOSX/',         true,  '__MACOSX dir trailing slash'],
    ['__MACOSX/file',     true,  'inside __MACOSX'],
    ['root/__MACOSX/x',   true,  'nested __MACOSX'],
    // 通常のファイル — 隠さない
    ['foo.wav',           false, 'normal file'],
    ['./0001.wav',        false, 'normal file with ./ prefix'],
    ['dir/file.json',     false, 'normal file in subdir'],
    ['.gitignore',        false, 'dotfile that is not metadata'],
    ['_underscore.txt',   false, 'single underscore (not "._")'],
  ])('%s -> %s (%s)', (name, expected) => {
    expect(isMacOsMetadata(name)).toBe(expected)
  })
})
