import { describe, expect, it } from 'vitest'
import { TarIndexLimitError, TarIndexStore } from './tar-index-store.js'

describe('tar索引の保存', () => {
  it('巨大な名前は省略せず上限エラーにし、取得済みの索引は保つ', () => {
    const store = new TarIndexStore()
    try {
      const entry = { name: 'valid.mp4', size: 1024 ** 3, type: 'file', bodyOffset: 512 }
      store.begin()
      store.append(entry)
      expect(() => store.append({ ...entry, name: 'x'.repeat(16 * 1024 + 1) })).toThrow(TarIndexLimitError)
      store.commit()
      expect(store.entryCount).toBe(1)
      expect(store.find('valid.mp4')).toEqual(entry)
    } finally { store.close() }
  })

  it('同名のファイルが複数あれば最初の本文位置を使い、一覧には両方を載せる', () => {
    const store = new TarIndexStore()
    try {
      const first = { name: 'same.mp4', size: 1, type: 'file', bodyOffset: 512 }
      const second = { ...first, bodyOffset: 1536 }
      store.begin(); store.append(first); store.append(second); store.commit()
      expect(store.find('same.mp4')).toEqual(first)
      expect(store.list(0, 2)).toEqual([first, second])
    } finally { store.close() }
  })
})
