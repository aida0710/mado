import { describe, expect, it } from 'vitest'
import { createGzip } from 'node:zlib'
import { pack } from 'tar-stream'
import { iterateTarEntries } from './tar-iterate.js'

function makeTar(entries: Array<[string, Buffer]>): NodeJS.ReadableStream {
  const p = pack()
  for (const [name, body] of entries) p.entry({ name }, body)
  p.finalize()
  return p
}

describe('iterateTarEntries', () => {
  it('全エントリを順に body 付きで yield する', async () => {
    const tar = makeTar([
      ['a.wav', Buffer.from('AAAA')],
      ['a.txt', Buffer.from('hello')],
    ])
    const seen: Array<[string, string]> = []
    await iterateTarEntries(tar, 'tar', async (h, body) => {
      seen.push([h.name, body.toString()])
    }, { entryMaxBytes: 1024 })
    expect(seen).toEqual([['a.wav', 'AAAA'], ['a.txt', 'hello']])
  })

  it('entryMaxBytes 超過のエントリは skip して続行する', async () => {
    const tar = makeTar([
      ['big.wav', Buffer.alloc(100)],
      ['small.txt', Buffer.from('ok')],
    ])
    const seen: string[] = []
    await iterateTarEntries(tar, 'tar', async h => { seen.push(h.name) }, { entryMaxBytes: 10 })
    expect(seen).toEqual(['small.txt'])
  })

  it('gz 圧縮された tar も読める', async () => {
    const gz = createGzip()
    makeTar([
      ['a.wav', Buffer.from('AAAA')],
      ['a.txt', Buffer.from('hello')],
    ]).pipe(gz)
    const seen: Array<[string, string]> = []
    await iterateTarEntries(gz, 'gz', async (h, body) => {
      seen.push([h.name, body.toString()])
    }, { entryMaxBytes: 1024 })
    expect(seen).toEqual([['a.wav', 'AAAA'], ['a.txt', 'hello']])
  })

  // タイムアウトを明示: エラー伝播が壊れて iterateTarEntries がハングした場合、
  // テストが 5 秒で確実に落ちるようにする (デフォルトタイムアウト頼みにしない)。
  it('onEntry が reject したらそのエラーで reject する', { timeout: 5_000 }, async () => {
    const tar = makeTar([
      ['a.wav', Buffer.from('AAAA')],
      ['b.wav', Buffer.from('BBBB')],
    ])
    const seen: string[] = []
    await expect(iterateTarEntries(tar, 'tar', async h => {
      seen.push(h.name)
      if (h.name === 'a.wav') throw new Error('analyze failed')
    }, { entryMaxBytes: 1024 })).rejects.toThrow('analyze failed')
    // 失敗したエントリより後は処理されない。
    expect(seen).toEqual(['a.wav'])
  })

  it('onEntry が同期 throw してもそのエラーで reject する', { timeout: 5_000 }, async () => {
    const tar = makeTar([['a.wav', Buffer.from('AAAA')]])
    await expect(iterateTarEntries(tar, 'tar', () => {
      throw new Error('sync boom')
    }, { entryMaxBytes: 1024 })).rejects.toThrow('sync boom')
  })
})
