import { describe, expect, it } from 'vitest'
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
})
