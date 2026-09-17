import { describe, expect, it } from 'vitest'
import { api } from './client'

const parse = (url: string) => new URL(url, 'http://x')

describe('api.tarEntryUrl', () => {
  it('既定では maxBytes を付けない (本体を全部返させる)', () => {
    const u = parse(api.tarEntryUrl({ connectionId: 'c1', bucket: 'b', key: 'rec/a.tar', entry: 'deep/x.wav' }))
    expect(u.pathname).toBe('/api/internal/storage/c1/preview/tar-entry')
    expect(u.searchParams.get('bucket')).toBe('b')
    expect(u.searchParams.get('key')).toBe('rec/a.tar')
    expect(u.searchParams.get('entry')).toBe('deep/x.wav')
    expect(u.searchParams.has('maxBytes')).toBe(false)
  })

  it('maxBytes を渡すと head モードのクエリが付く', () => {
    const u = parse(api.tarEntryUrl({ connectionId: 'c1', bucket: 'b', key: 'a.tar', entry: 'x.npy', maxBytes: 65536 }))
    expect(u.searchParams.get('maxBytes')).toBe('65536')
  })

  it('特殊文字を含むエントリ名でも壊れない', () => {
    const u = parse(api.tarEntryUrl({ connectionId: 'c 1', bucket: 'b/1', key: 'a b.tar', entry: 'e?#%&.bin', maxBytes: 1 }))
    expect(u.searchParams.get('entry')).toBe('e?#%&.bin')
    expect(u.searchParams.get('key')).toBe('a b.tar')
    expect(u.searchParams.get('maxBytes')).toBe('1')
  })
})
